# TS 말포이 — 내 PC에서 돌아가는 AI

처음부터 여자였던 드레이코 말포이(TS 말포이)와 대화하는 데스크톱 앱입니다. 인터넷 없이 그래픽카드 한 장에서 돌아갑니다.

> 비공식 팬 프로젝트입니다. 해리 포터 관련 권리는 각 권리자에게 있습니다. 상업적으로 이용하지 않습니다.

## 할 수 있는 것

- **대화**: 오만하고 얄미운데 감정이 얼굴에 다 드러나는 말포이. 관계가 앙숙 → 라이벌 → 들킴 → 휴전 → 특별함으로 바뀝니다.
- **기억**: 포터가 했던 말과 있었던 일을 오래 기억합니다. 대화가 길어지면 스스로 요약합니다.
- **사진**: 사진을 붙이면 무엇이 찍혔는지 보고 반응합니다.
- **음성 대화**: 말로 걸면 말포이 목소리로 대답합니다. 목소리는 이 프로젝트에서 직접 설계하고 학습한 오리지널 목소리입니다.
- **스토리**: 원작의 장면에서 시작하거나 말포이가 상황을 열고, 이야기가 이어집니다. 책처럼 읽고 텍스트로 저장할 수 있습니다.
- **부엉이 편지**: 가끔 말포이가 먼저 편지를 보냅니다.

## 필요한 PC

| | 최소 | 권장 |
|---|---|---|
| 그래픽카드 | 없어도 됨 (CPU, 느림) | NVIDIA 8GB 이상 |
| RAM | 16GB | 32GB |
| 디스크 | 약 8GB | |

설치할 때 PC를 검사해서 엔진(CUDA / Vulkan / CPU)과 모델 크기를 고릅니다. 설정의 **성능** 항목은 그래픽카드·RAM 크기에 맞춰 자동으로 잡히고, 대화 기억 길이와 메모리 절약(대화 기억을 4비트로 저장)은 직접 바꿀 수 있습니다.

## 설치

[Releases](../../releases)에서 설치 파일을 받아 실행합니다. 처음 실행하면 필요한 엔진과 모델을 받습니다.

## 소스에서 실행

```bash
cd app
npm install
npm start
```

말포이 전용 모델 파일은 크기 때문에 저장소에 넣지 않았습니다. Releases에서 받아 아래 위치에 넣습니다.

| 파일 | 위치 | 내용 |
|---|---|---|
| `malfoy-lora.gguf` | `app/persona/` | 성격 LoRA (Gemma 4 E4B) |
| `malfoy-tts-Q4_K_M.gguf` | `app/persona/voice/` | 말포이 목소리 TTS (Qwen3-TTS 1.7B 미세조정) |
| `mmproj-malfoy-tts-Q8_0.gguf` | `app/persona/voice/` | 위 TTS의 보조 모델과 음성 디코더 |

음성 엔진(`app/native/tsm-tts-server.exe`)을 직접 빌드하려면 Visual Studio(C++), CMake, Ninja를 설치하고 `native/build.bat`을 실행합니다. llama.cpp는 고정된 커밋으로 받아 오고, 이 프로젝트의 코드는 `native/tts-server/`뿐입니다.

## 어떻게 만들었나

- **두뇌**: Google Gemma 4 E4B (QAT Q4_0) + llama.cpp. 생각 모드는 끄고, MTP 추측 디코딩으로 빠르게 답합니다.
- **성격**: 원본 모델에 성격 프롬프트(`app/persona/prompt_v3.txt`)를 주고 나온 실제 대화를 모아 LoRA로 학습했습니다(자기 증류). 코드는 `training/`에 있습니다.
  - `gen_v3.py` 대화 생성 → `build_v3.py` 거르기·말버릇 정리 → `train_persona_lora.py` (NF4 QLoRA)
- **목소리**: Qwen3-TTS VoiceDesign으로 목소리를 설계한 뒤, 같은 방식으로 만든 문장 중 원본과 음높이·음색이 가까운 것만 골라 1.7B 모델을 LoRA로 미세조정했습니다. 앱은 그 모델을 llama.cpp 기반 상주 서버로 돌립니다.
  - `training/voice/`: `gen_design.py` → `prep.py asr` → `prep.py encode` → `train_voice.py` → `merge.py`
- **조사 문서**: `docs/` (유행 분석, 원작 사건, 팬덤 설정, 감정선, 학습 실측, 개발 기록)

## 라이선스·크레딧

- 모델: Google Gemma 4 (Apache-2.0), Qwen3-TTS (Apache-2.0)
- 엔진: llama.cpp (MIT)
- 글꼴: Pretendard, 고운바탕 (SIL OFL)
- 이 저장소의 코드와 문서: [GPL-3.0](LICENSE). 고쳐서 배포할 때는 소스도 같은 라이선스로 공개해야 합니다.
- 학습한 LoRA·목소리 모델은 각 원본 모델(Gemma, Qwen3-TTS)의 라이선스 조건도 함께 따릅니다.
