# CLAUDE.md — maltoo 개발 가이드

이 문서는 이 저장소에서 작업하는 Claude(및 개발자)를 위한 개발 계획과 규칙입니다.
제품 기능 명세는 `README.md`가 기준입니다. 둘이 어긋나면 README를 먼저 갱신하세요.

## 작업 원칙

- 사용자(저장소 주인)의 선호: **질문이 명확할 때 답하고, 코드·샘플을 대량으로 내기 전에는 먼저 물어보고 진행**한다.
- 문서와 UI 문구, 커밋 메시지 본문은 **한국어**로 작성한다. 코드 식별자는 영어.
- 큰 기능은 단계(아래 로드맵)별로 나눠 커밋한다.

## 아키텍처

```
maltoo/
├─ main.py              # FastAPI 앱 진입점, 정적 파일 서빙
├─ config.json          # 모델 이름, 가격표, 기본 비용 한도, 음성/이미지 설정 (비밀 정보 없음)
├─ app/
│  ├─ api/              # 라우터: scenarios, turn, transcribe, tts, analyze, usage, assets
│  ├─ openai_client.py  # 요청마다 전달받은 API 키로 클라이언트 생성 (키 저장 금지)
│  ├─ usage.py          # 사용량 → 비용 계산, 한도 검사(서버측 차단)
│  ├─ cache.py          # 음성/이미지 캐시 키 계산, manifest 관리
│  ├─ prompts/          # 인물 연기, 턴 분석, 최종 리포트 프롬프트
│  ├─ report.py         # 교정 리포트 점수 계산·코칭 프롬프트
│  ├─ schemas.py        # API 요청 본문 모델 (Pydantic) — 라우터는 여기서 가져다 씀
│  ├─ world.py          # 인물 관계, 소문 전파, 누적 기억(호감·신뢰·연봉) 갱신
│  └─ db.py             # SQLite (sessions, turns, usage, baseline, world_state, rumors) → data/maltoo.db
├─ scenarios/           # 시나리오 정의 JSON (인물, 상황, 목표, 첫마디, 재촉 대사, 소문 버전 첫마디)
│  └─ world.json        # 조직도, 인물 간 관계
├─ data/               # 개인 기록 DB maltoo.db (커밋 안 함, 예전 루트 data.db 는 자동 이동)
├─ .runtime/           # 실시간 대사 음성 (커밋 안 함)
├─ static/
│  ├─ index.html
│  ├─ js/
│  │  ├─ audio/         # 녹음, VAD(3초/1.5초), 음높이·음량·속도·끝억양 측정
│  │  ├─ face/          # MediaPipe Face Landmarker, 표정 지표 집계
│  │  ├─ ui/            # 오른쪽 패널, 하단 파형/체크포인트 띠, 인물 이미지 전환, ElevenLabs 창
│  │  ├─ views/         # 화면별 모듈: history(기록) · setup(초기 세팅) · report(교정 리포트) · game(연봉·퇴사·인사고과) · baseline(내 캐릭터 확인) · talk(대화 화면). main.js 는 시나리오 선택·브리핑·난이도·키 입력·설정·시작만
│  │  ├─ util.js        # $, esc, toast, showError
│  │  ├─ media.js       # 마이크·카메라 공용 객체 (측정·대화 화면 공유)
│  │  └─ session.js     # 턴 상태 머신
│  └─ css/
├─ assets/              # ★ 커밋 대상 캐시
│  ├─ audio/            # 고정 대사 mp3 + manifest.json
│  ├─ brand/            # 랑프두잇 로고 (logo.jpg)
│  ├─ models/           # face_landmarker.task (처음 실행 시 자동 다운로드)
│  ├─ characters/       # <인물id>/<표정>.webp, <표정>_talk.webp + manifest.json + _mouth_mask.png
│  └─ endings/          # review.webp, resign_<id>.webp + manifest.json
└─ tests/
```

### 데이터 흐름 (한 턴)
1. 서버가 상대 대사 반환 → 고정 대사면 `assets/audio` 캐시 재생, 아니면 TTS 생성
2. 재생 종료 → 마이크 ON, 3초 타이머. 무응답이면 재촉 대사(캐시) 재생, 최대 2회
3. 발화 중: 브라우저가 톤·표정 지표를 실시간 계산해 하단 띠와 톤 미터에 표시, 즉시 체크포인트 생성
4. 1.5초 무음 → 녹음 종료 → `/api/transcribe`
5. `/api/turn`: 문장 + 톤 지표 + 표정 지표 + 이전 대화 + 인물 상태 + **세계 상태(관계·소문·누적 호감)** → gpt-4o-mini가 **JSON 한 번**으로 반환
   - `emotion` {anger, trust, defensiveness, delta, reason}
   - `goal` {progress, checklist[]}
   - `checkpoints[]` {type, text_span, note}
   - `mentions[]` {character, sentiment}: 다른 인물 언급·험담 감지
   - `reply` (상대의 다음 대사) / `ending` (null | success | partial | fail | resigned)
6. 서버가 결과로 게임 수치 계산 (gpt가 아니라 `world.py`/`config.json` 규칙으로 결정적 계산)
   - 상사 시나리오: 연봉 변동 / 부하 시나리오: 퇴사 위험도, (7번) 팀 불만
   - 험담 → 소문 확률 판정 → `rumors` 저장, 대상 인물 호감·신뢰 갱신
7. 비용 기록 → 오른쪽 패널 갱신

### 핵심 규칙
- **API 키**: 브라우저 localStorage에만 저장. 요청 헤더(`X-OpenAI-Key`)로 받아 해당 요청에만 사용. 로그·DB·파일에 절대 남기지 않는다. 비용 집계는 키 끝 4자리로만 구분.
- **비용 한도**: 모든 OpenAI 호출은 `usage.py`의 한도 검사를 거친다. 한도 초과 시 호출하지 않고 HTTP 402/429 + 안내 메시지. 호출 전 예상 비용으로 사전 검사.
  - 예외: 초기 세팅(`/api/setup/job`)은 사용자가 예상 비용을 확인하고 시작하므로 한도 검사를 생략하고 `exempt=1`로 기록한다 (표시는 하되 한도 합계에서 제외, session_id=`setup`).
- **고정 대사 종류**: `scenarios.fixed_lines()` — opening·nag1·nag2, `react_<angry|neutral|soft>_<n>`(추임새, `cached_only`로만 재생·없으면 생략), `end_<success|partial|fail|noresp|resign>`(결말, 있으면 GPT 대사 대신 사용). 추임새 그룹은 직전 턴 감정으로 결정(시작값 `reaction_start`).
- **초기 세팅**: 키 입력 시 `/api/setup/status`로 고정 음성·인물 사진 존재를 확인하고, 없으면 앱에서 생성한다. 생성물(`assets/`)은 사용자가 GitHub에 커밋해서 재사용한다. 앱 실행 중에는 사진을 새로 만들지 않는다.
- **인물 사진**: 실사. 외모는 `scenarios.json`의 `appearance_prompt`(영어, 얼굴형·눈·눈썹·코·입·피부·머리·나이 흔적·체격·옷·소품·인상 항목별)와 `expression_notes`(인물별 표정)로 지정, 7명 공통 촬영 조건은 `portraits.PHOTO_SPEC`. 화면용 한국어 요약은 `appearance`. calm 기본 사진 → 표정 4종 edit → 표정별 입 벌림 edit(입 주변 마스크). 이미지 모델은 `gpt-image-1-mini`(사용자 지정) — `input_fidelity=high` 미지원이라 생략하고, 편집 프롬프트에 외모를 다시 명시해 얼굴을 유지한다. 입 움직임은 재생 음량으로 `_talk` 사진 투명도를 조절한다.
- **영상 비전송**: 카메라 프레임은 서버로 보내지 않는다. 수치 요약만 전송. 체크포인트 순간 캡처는 브라우저 메모리에만 두고 결과 화면에서 사용자가 직접 저장.
- **표정 분석**: MediaPipe tasks-vision 1.2.3 을 `static/vendor/mediapipe/`에 포함(CDN 미사용). 얼굴 모델은 `/api/face-model`이 처음 한 번 `assets/models/face_landmarker.task`로 받아 저장(커밋해서 재사용). 계산 로직은 `static/js/face/metrics.js`(순수, `node tests/js/face.test.mjs`로 검증), 카메라 연결은 `face/camera.js`. 구간(phase): listen(상대 발화·추임새)·silence(3초 카운트)·speak(내 발화). 체크포인트 😠찌푸림 🙄눈 굴림 👀시선 회피 😏비웃음 😤입술 꽉 😒입꼬리 내림 ⬆️턱 듦, 요약에 무표정·깜빡임. 표정 기준값은 "내 캐릭터 확인"에서 목소리와 함께 측정해 `baseline.face`에 저장. 요약은 `/api/turn`의 `face`로 보내 `prompts/face.py`가 설명으로 바꾼다.
- **모델/가격 하드코딩 금지**: 모두 `config.json`에서 읽는다.
- **목소리 감정**: 지시문 = `scenarios.json` `voice.profile`(인물 프로필, 영어) + `config.json` `voice_moods[감정]` + `voice_style_suffix` (`scenarios.voice_for`). 고정 대사 감정은 `scenarios.line_mood` (opening=시작 감정, nag1 짜증, nag2 분노, 추임새 그룹별, 결말별, 소문 짜증). 실시간 대사는 클라이언트가 직전 턴 감정으로 `exprFromEmotion` 단계를 계산해 `/api/tts/say`의 `mood`로 보낸다. 프로필·감정 문구를 바꾸면 고정 음성을 다시 생성해야 한다. 재생 시 감정 강조: `static/js/audio/voicefx.js` + `config.json` `voice_playback`(감정별 gain·rate, 세기 off/low/normal/strong) → `playUrl`의 `fx`(GainNode + 컴프레서, playbackRate·preservesPitch=false). TTS 응답에 `mood` 포함.
- **직접 넣은 음성**: `assets/audio/custom/<인물 id>/<대사 id>.mp3`가 있으면 생성 음성보다 우선(`cache.custom_path`), 초기 세팅에서 건너뜀. 현재 7명 고정 대사 129개 전부 ElevenLabs Eleven v4(실시간 대사만 OpenAI). 일괄 생성: `app/eleven.py` + `/api/eleven/{status,voices,line}`(키는 `X-ElevenLabs-Key` 헤더로만, 저장 금지), 대본 `scenarios/elevenlabs.json`(직접 쓴 lines 우선, 없으면 mood_tags 하나), 모델·voice_settings는 `config.json` `elevenlabs`, 결과 기록 `custom/manifest.json`, 화면 `static/js/ui/eleven.js`(인물별 목소리 선택은 localStorage). 실시간 대사는 OpenAI 유지.
- **캐시 키에 모델 이름 미포함**: 오디오 = hash(대사 + voice + instructions), 이미지 = hash(인물 + 표정 + 프롬프트). 모델·생성일은 manifest에 기록.
- **기준선 보정**: 톤·표정 지표는 사용자 baseline 대비 비율로 계산·전달.
  - "내 캐릭터 확인": 시나리오를 처음 누를 때 baseline 이 없으면 측정 화면(카메라 미리보기 + 평서·설명·질문·부탁·거절 5문장, 유성음 10초)을 띄운다. 건너뛰면 `DEFAULT_BASELINE`. 설정에서 다시 측정 가능. 저장: `/api/baseline` → `baseline` 테이블(최신 1건 사용).
- **톤 분석**: `static/js/audio/tone.js` (브라우저 전용). YIN 음높이, 음량 dB, 영교차율. 실시간 체크포인트 🔊loud 📈high ⏩fast ⤵fall 💥stress 😮‍💨sigh, 톤 미터(격앙도·따뜻함). 발화 요약(`tone`)을 `/api/turn`에 보내고 `prompts/tone.py`가 한국어 설명으로 바꿔 gpt-4o-mini 판단에 넣는다. 알고리즘 회귀 테스트: `node tests/js/tone.test.mjs`.
- **에코 방지**: TTS 재생 중에는 VAD·톤 분석을 멈추고 `echoCancellation`을 켠다.
- **회사·브랜드**: 무대는 가상의 로봇 제조 회사 **랑프두잇**. UI는 `assets/brand/logo.jpg`와 로고 색(포인트 `#FFCD4A`, 외곽선 `#000000`, 배경 `#FFFFFF`)을 기준으로 꾸민다. 굵은 검정 외곽선 + 노랑 포인트 스타일. 인물 대사·이미지 프롬프트의 회사 배경도 로봇 회사로 맞춘다.
- **나는 항상 과장**: 모든 시나리오에서 사용자 직급은 과장. 대사의 호칭도 이에 맞춘다.
  - **말 높이**: 상사는 과장에게 반말, 부하는 존댓말(`prompts/character.speech_rule`, 시스템 프롬프트 + 매 턴 안내). 실시간 대사는 서버가 `character.speech_ok`로 검사해 어긋나면 한 번 다시 받는다. 녹음된 고정 대사는 검사하지 않음(한 팀장 고정 대사는 존댓말).
- **게임 수치는 결정적 규칙으로**: 연봉 감액·퇴사 위험도·소문 확률은 `config.json`의 `game` 설정으로 계산한다. gpt-4o-mini는 감정·언급 판단만 하고 금액을 정하지 않는다.
  - 기본 연봉 3,500만 원, 분노+10 −30만 / 신뢰−10 −20만 / 공격 표현 −40만 / 응답 회피 −50만 / 잘한 대응 +20만(누적 감액의 50%까지만 회복)
  - 고과: A +3% / B +1.5% / C 동결 / D −5% / 최악 인사팀 면담. 성공+감액 적음 A, 성공 또는 부분 성공+달성도 67%↑ B, 부분 성공 C, 실패·감액 큼 D (`world.finish`, 이유 문구 함께 표시)
  - 결말은 체크리스트와 맞춤: 전부 채우면 성공, 마지막 턴에 핵심(마지막) 항목 포함 하나 빼고 채우면 성공. 달성도 %는 체크 수에 맞춤(3개 중 1개 → 33~50%)
- **누적 기억**: `world_state`(인물별 호감·신뢰·퇴사 위험·팀 불만·퇴사 여부), `settings.salary_krw`(현재 연봉), `rumors`는 세션을 넘어 유지. "새 회사 입사"(`/api/world/reset`)로만 초기화.
- **세계관 엔진**: `app/world.py` — `/api/world/start`(소문 대기 시 첫마디 `rumor_<n>` + 시작 페널티), `/api/turn` 응답의 `game`(연봉 변동·이유, 퇴사 위험·단계, 팀 불만, 언급 효과, 소문 발생, `ending_override`=resign|team_quit), `/api/world/finish`(인사고과 A/C/D·면담). 클라이언트가 `prev_emotion`·`game_session{cut,recovered}`를 턴마다 보낸다. 소문 판정은 `random.Random(session_id:turn:target)`으로 재현 가능. 인물 관계는 `scenarios/world.json`, 수치는 `config.json` `game`.
- **엔딩 장면**: `assets/endings/review.webp`(인사고과), `resign_<부하 id>.webp`(사직서, 인물 calm 사진 기준 edit) — 초기 세팅에서 생성, 커밋해서 재사용.
- **교정 리포트**: `/api/report` — 톤·표정 점수는 `app/report.py`의 결정적 공식(같은 입력→같은 점수, JS `toneScore`와 동일 공식 유지), 말 점수·총평·교정 카드(original/problem/better/tone_tip/face_tip)·습관·다음 과제는 gpt-4o-mini. 종합 = 말 0.4·톤 0.35·표정 0.25 가중 평균(없는 항목 제외)×0.85 + 목표 달성도×0.15. 결과는 `sessions.summary`/`turns`에 저장, `/api/history`로 추이. 모범 답변은 `/api/tts/coach`(config `coach` 목소리). 다시 말해보기는 브라우저에서 톤을 재측정해 처음 턴과 비교.
- **난이도**: config `difficulty` (mild 5초·힌트 1번 / normal 3초·최소 1번 반박·초반 success 금지 / spicy 3초·2번 이상 반박), `/api/turn`의 `difficulty`로 프롬프트에 반영.
- **험담 피드백**: 험담 전략은 리포트에서 칭찬하지 않고 위험을 함께 짚는다.

## 로드맵

### Phase 0 — 기반
- [x] FastAPI 골격, `config.json`, SQLite 스키마
- [x] API 키 입력 모달 + 유효성 검사(무료 엔드포인트), localStorage 저장
- [x] OpenAI 호출 래퍼 + 사용량/비용 계산 + 한도 차단
- [x] 오른쪽 비용 패널

### Phase 1 — 대화 루프
- [x] 시나리오 7종 JSON, 시나리오 선택 화면, 상황·목표 카드
- [x] TTS 재생 + 오디오 캐시(`assets/audio`) + 초기 세팅에서 일괄 생성
- [x] 녹음, VAD(3초 재촉 / 1.5초 종료), 재촉 2회 로직
- [x] 음성 인식 → 인물 연기 응답 (최대 5턴), 결말 판정

### Phase 2 — 톤 분석
- [x] baseline 측정(30초) 화면
- [x] 음량·음높이(autocorrelation/YIN)·말 속도·끝 억양·강세·한숨 근사 감지
- [x] 하단 파형 + 음높이 선 + 즉시 체크포인트, 내 톤 미터

### Phase 3 — 표정 분석
- [x] MediaPipe Face Landmarker 연동 (blendshapes, head pose, gaze)
- [x] 듣는 중/침묵 중/말하는 중 구간별 집계, 표정 체크포인트
- [x] 피크 순간 로컬 캡처, 내 화면 숨기기 옵션

### Phase 4 — 실시간 패널 · 인물 이미지
- [x] 턴별 통합 분석 JSON → 상대 감정 게이지, 목표 체크리스트, 대사 체크포인트(💢🛡🧊😏✅)·톤 피드백 (인물 언급 감지는 Phase 5)
- [x] 인물 이미지 생성 파이프라인(기본 초상 → 표정 편집) + `assets/characters` 캐시 — 초기 세팅 창에서 생성
- [x] 감정 수치에 따른 표정 5단계 전환, 말할 때 입 움직임

### Phase 5 — 게임 장치 · 세계관
- [x] `world.json` 조직도·관계, `world_state`/`rumors` 스키마
- [x] 연봉 패널 + 실시간 감액 애니메이션, 인사고과 결말
- [x] 퇴사 위험도 게이지 + 단계 메시지 + 퇴사 엔딩, 7번 팀 불만 게이지
- [x] 인물 언급 감지 → 관계 반응, 소문 전파 → 첫마디 변형·시작 연봉 감액
- [x] 엔딩 장면 이미지(`assets/endings`), "새 회사 입사" 초기화

### Phase 6 — 교정 · 기록
- [x] 최종 리포트: 문제 표현 하이라이트, 대안 문장, 억양 팁(수치)
- [x] 모범 답변 TTS, 다시 말해보기 + 비교
- [x] 회차별 기록, 개선 추이 그래프
- [x] 난이도(순한 맛/보통/매운 맛), 첫 화면 안내(권한, 이어폰, AI 고지)

## 미결정 사항 (사용자 확인 필요)

현재는 괄호 안의 **추천안을 기본값**으로 진행한다. 사용자가 다르게 정하면 이 목록과 README를 갱신한다.

- [x] 인물 이미지 스타일: **실사** (확정), 대화 화면에 크게 표시 + 입 움직임
- [x] 목소리 분석 깊이: A 수치만 (구현됨)
- [x] 보완점(baseline, 이어폰 안내, 난이도, 모범 답변, 첫 화면 안내) — 전부 구현
- [ ] 상대 성별 선택 기능 (없음, 기본 혼합 구성)
- [x] 사용자 직급 과장으로 통일, 누적 기억 포함, 소문 시스템 포함, 기본 연봉 3,500만 원 (확정)
- [ ] 코드 전 화면 시안 확인 여부

## 실행 · 테스트

```bash
pip install -r requirements-dev.txt   # 실행만 할 때는 requirements.txt
python main.py          # http://localhost:8000
pytest                  # 테스트 파일은 기능 이름: test_conversation / test_world / test_report / test_usage_and_key …
ruff check .            # 린트 (설정은 pyproject.toml)
```
