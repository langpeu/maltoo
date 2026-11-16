# 직접 넣은 음성

`custom/<인물 id>/<대사 id>.mp3` 가 있으면 OpenAI로 만든 음성 대신 이 파일을 재생합니다.
목소리 지시문을 바꿔도 그대로 유지되고, 초기 세팅에서 다시 만들지 않습니다.

대사 id: `opening`, `nag1`, `nag2`, `react_<angry|neutral|soft>_<n>`, `end_<success|partial|fail|noresp|resign>`, `rumor_<n>`
(전체 목록은 `scenarios.fixed_lines()`)

| 파일 | 출처 |
|---|---|
| kim/opening.mp3 | ElevenLabs Eleven v4 (stability 20, similarity 30), 사용자가 직접 생성 |
| kim/nag1.mp3 | ElevenLabs Eleven v4 (stability 20, similarity 30) |
| kim/nag2.mp3 | ElevenLabs Eleven v4 (stability 20, similarity 30) |
