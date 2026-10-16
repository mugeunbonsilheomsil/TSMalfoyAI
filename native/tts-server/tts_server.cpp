// tsm-tts-server — 상주형 TTS (llama.cpp mtmd 음성 생성, Qwen3-TTS 등)
// 모델을 한 번만 올리고 stdin 의 JSON 한 줄마다 WAV 하나를 만든다.
//   요청: {"id":"1","text":"...","lang":"ko","speaker":"ref.wav","out":"x.wav","seed":42,"max_frames":400}
//   응답: {"id":"1","ok":true,"out":"x.wav","audio_s":2.4,"ms":610}      준비되면 {"ready":true}
// tools/tts/tts.cpp 를 기반으로 반복 처리만 추가했다.
#include "arg.h"
#include "common.h"
#include "sampling.h"
#include "log.h"
#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"
#include <nlohmann/json.hpp>

#include <cstdio>
#include <iostream>
#include <map>
#include <string>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

using json = nlohmann::ordered_json;

// JSON 경로는 UTF-8. Windows 의 fopen 은 ANSI 코드 페이지로 해석해서 한글 경로(예: 한글 사용자 이름의 AppData)가 깨지거나 열리지 않는다.
static FILE * fopen_utf8(const std::string & path, const char * mode) {
#ifdef _WIN32
    auto wide = [](const std::string & s) {
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int) s.size(), nullptr, 0);
        std::wstring w(n, L'\0'); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int) s.size(), w.data(), n); return w;
    };
    return _wfopen(wide(path).c_str(), wide(mode).c_str());
#else
    return fopen(path.c_str(), mode);
#endif
}

static bool read_file(const std::string & path, std::vector<unsigned char> & out) {
    FILE * f = fopen_utf8(path, "rb");
    if (!f) return false;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    out.resize(n > 0 ? (size_t) n : 0);
    bool ok = n > 0 && fread(out.data(), 1, out.size(), f) == out.size();
    fclose(f); return ok;
}

static void reply(const json & j) {
    std::string s = j.dump();
    fwrite(s.data(), 1, s.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

int main(int argc, char ** argv) {
    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_TTS, nullptr)) return 1;
    mtmd_helper_log_set(common_log_default_callback, nullptr);
    if (params.mmproj.path.empty()) { LOG_ERR("--mmproj required\n"); return 1; }
    params.embedding = true;

    llama_backend_init();
    llama_numa_init(params.numa);
    auto llama_init = common_init_from_params(params);
    llama_model    * model = llama_init->model();
    llama_context  * lctx  = llama_init->context();
    common_sampler * smpl  = llama_init->sampler(0);
    if (!model || !lctx) { LOG_ERR("failed to init model\n"); return 1; }

    mtmd_context_params mp = mtmd_context_params_default();
    mp.use_gpu = params.mmproj_use_gpu;
    mp.device  = params.mmproj_device;
    mtmd::context_ptr mctx(mtmd_init_from_file(params.mmproj.path.c_str(), model, mp));
    if (!mctx || mtmd_gen_audio_get_info(mctx.get()).type == MTMD_GEN_AUDIO_TYPE_NONE) { LOG_ERR("mmproj has no audio generation\n"); return 1; }

    mtmd_helper::gen_audio gen(lctx, mctx.get());
    std::map<std::string, mtmd::bitmap_ptr> speakers;     // 화자 참조 음성은 경로별로 한 번만 처리
    reply({{"ready", true}});

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json req, res;
        try { req = json::parse(line); } catch (...) { reply({{"ok", false}, {"error", "bad json"}}); continue; }
        res["id"] = req.value("id", "");
        if (req.value("cmd", "") == "quit") break;
        const int64_t t0 = ggml_time_us();
        const std::string text = req.value("text", ""), out = req.value("out", ""), spk = req.value("speaker", ""), lang = req.value("lang", "ko");
        if (text.empty() || out.empty()) { res["ok"] = false; res["error"] = "text/out required"; reply(res); continue; }

        mtmd_bitmap * spk_bmp = nullptr;
        if (!spk.empty()) {
            auto it = speakers.find(spk);
            if (it == speakers.end()) {
                std::vector<unsigned char> buf;
                if (!read_file(spk, buf)) { res["ok"] = false; res["error"] = "speaker load failed"; reply(res); continue; }
                auto w = mtmd_helper_bitmap_init_from_buf(mctx.get(), buf.data(), buf.size(), false, mtmd_helper_init_opt_default());
                if (!w.bitmap) { res["ok"] = false; res["error"] = "speaker load failed"; reply(res); continue; }
                it = speakers.emplace(spk, mtmd::bitmap_ptr(w.bitmap)).first;
            }
            spk_bmp = it->second.get();
        }

        gen.reset();
        llama_memory_clear(llama_get_memory(lctx), true);
        common_sampler_reset(smpl);

        mtmd_helper_gen_audio_inp inp{};
        inp.seq_id = 0; inp.prompt = text.c_str(); inp.prompt_len = text.size(); inp.speaker_ref = spk_bmp; inp.lang = lang.c_str();
        inp.top_k = params.sampling.top_k; inp.top_p = params.sampling.top_p;
        inp.seed = req.value("seed", (uint32_t) params.sampling.seed);
        inp.out_type = MTMD_HELPER_GEN_AUDIO_OUTTYPE_WAV;
        if (gen.set_input(&inp) != 0) { res["ok"] = false; res["error"] = "set_input failed"; reply(res); continue; }

        bool fail = false;
        for (;;) { int32_t r = gen.step_prompt(params.n_batch); if (r < 0) { fail = true; break; } if (r == 0) break; }
        if (fail) { res["ok"] = false; res["error"] = "prompt failed"; reply(res); continue; }

        auto sample = [&]() { llama_token t = common_sampler_sample(smpl, lctx, -1); common_sampler_accept(smpl, t, true); return t; };
        const int max_new = req.value("max_frames", params.n_predict > 0 ? params.n_predict : 512);
        llama_token sampled = sample();
        const float * h = llama_get_embeddings_ith(lctx, -1);
        bool stop = false; int n = 0;
        while (!stop && n < max_new) {
            const float * hn = nullptr;
            if (gen.step_gen(sampled, h, &hn, &stop) != 0) { fail = true; break; }
            if (!hn) break;
            n++; h = hn; sampled = sample();
        }
        if (fail) { res["ok"] = false; res["error"] = "generation failed"; reply(res); continue; }

        int32_t sr = 0; const char * data = nullptr; size_t len = 0; int64_t ns = 0;
        if (gen.get_output(&sr, &data, &len, &ns) != 0) { res["ok"] = false; res["error"] = "output failed"; reply(res); continue; }
        FILE * f = fopen_utf8(out, "wb");
        if (!f) { res["ok"] = false; res["error"] = "cannot write"; reply(res); continue; }
        fwrite(data, 1, len, f); fclose(f);
        res["ok"] = true; res["out"] = out; res["frames"] = n;
        res["audio_s"] = sr > 0 ? (double) ns / sr : 0.0;
        res["ms"] = (ggml_time_us() - t0) / 1000;
        reply(res);
    }
    llama_backend_free();
    return 0;
}
