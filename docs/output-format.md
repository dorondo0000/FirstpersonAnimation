# 출력 포맷

플러그인과 `tools/make_examples.mjs`가 만들어내는 리소스팩 구조 전체.

## 파일 배치

```
pack.mcmeta
assets/<ns>/items/<item>.json                          ← item model definition (진입점)
assets/<ns>/models/item/<item>/parts/<bone>.json       ← 본마다 하나. 지오메트리는 여기 한 번만
assets/<ns>/models/item/<item>/cooldown_bar.json       ← 대체 쿨다운 바 (옵션)
assets/<ns>/textures/item/<item>/<texture>.png
assets/<ns>/textures/item/<item>/_cooldown_overlay.png ← 옵션
GIVE_COMMANDS.txt                                       ← 리소스팩에 무해한 부속 파일
README.txt
```

`parts/*.json`은 전부 **동일한 `display` 섹션**을 갖습니다. composite의 각 레이어가 자기 모델 파일의 `display`를 쓰기 때문에, 하나라도 다르면 부위가 어긋납니다.

## 전체 트리

```
items/<item>.json
└─ model: select  property=minecraft:display_context
   ├─ case ["firstperson_righthand","firstperson_lefthand"]
   │  └─ select  property=minecraft:custom_model_data  (index=0, strings)
   │     ├─ case "fire"   → composite
   │     │                   ├─ model  parts/<안 움직이는 본>       (transformation 상수 또는 없음)
   │     │                   └─ range_dispatch  property=minecraft:cooldown
   │     │                      ├─ threshold 0        → composite[프레임 N-1]  ← 대기 포즈
   │     │                      ├─ threshold 1/N      → composite[프레임 N-2]
   │     │                      ├─ ...
   │     │                      ├─ threshold (N-1)/N  → composite[프레임 0]
   │     │                      └─ fallback           → composite[프레임 N-1]
   │     ├─ case "reload" → (동일 구조)
   │     └─ fallback      → 첫 애니메이션 또는 설정한 기본 애니메이션
   ├─ case ["gui"]
   │  └─ composite
   │     ├─ 정지 포즈
   │     └─ condition  property=minecraft:custom_model_data  (index=0, flags)
   │        ├─ on_true  → range_dispatch  property=minecraft:cooldown  (바 높이 스케일)
   │        └─ on_false → empty
   └─ fallback → 정지 포즈 (ground / fixed / thirdperson / head ...)
```

## 프레임 클럭

`minecraft:cooldown`은 **남은** 쿨다운을 0.0~1.0으로 돌려줍니다. 걸린 순간 1.0, 만료 시 0.0, 쿨다운이 없으면 0.0.

```
진행도  = 1 - cooldown
프레임  = round(진행도 × (N-1))
```

`range_dispatch`는 "threshold ≤ 값"인 마지막 entry를 고르므로, `j = 0..N-1`에 대해

```
threshold j/N   →   프레임 (N-1-j)
```

를 내보냅니다. 결과:

| cooldown | 고르는 entry | 프레임 |
|---|---|---|
| 1.0 (막 사용) | `(N-1)/N` | 0 |
| 0.5 | `⌊N/2⌋/N` | 약 N/2 |
| 0.0 (평상시) | `0` | N-1 |

**그래서 마지막 키프레임이 대기 포즈여야 합니다.** 플러그인 설정의 `Reverse playback direction`으로 방향을 뒤집을 수 있습니다.

## transformation 계산

Blockbench 씬 공간과 Minecraft 모델 공간은 상수 평행이동만큼 차이납니다. 플러그인은 그 오프셋 `o`를 **루트 본에서 실측**합니다 — 영(zero) 포즈에서 루트 본의 월드 위치가 곧 그 본의 pivot이기 때문입니다. (루트 본이 2개 이상이면 서로 교차검증하고, 어긋나면 경고합니다.)

```
zeroPose(b)  = 모든 그룹 회전·스케일·애니메이션을 0으로 만든 본 b의 월드 행렬
Δ_scene(b,t) = pose(b,t) · zeroPose(b)⁻¹
Δ_model      = T(o) · Δ_scene · T(-o)
             → 3×3 부분은 그대로, 평행이동만  t_model = t_scene + (I - A)·o
```

그룹의 rest 회전도 여기서 자동으로 프레임 transformation에 흡수됩니다. 평범한 Java 모델은 회전된 본을 표현할 수 없으니 이게 맞는 동작입니다.

모델 공간 어파인 `v' = A·v + t_model` 을 Minecraft `transformation`으로:

```
t_mc = (A·pivot + t_model - pivot) / 16
```

`pivot`은 `corner`면 (0,0,0), `center`면 (8,8,8). 16으로 나누는 건 모델 단위(1/16 블록) → 블록 단위 변환입니다. **26.3 실측 결과 `corner` + 블록 단위가 맞습니다** ([calibration.md](calibration.md)).

출력은 항상 분해 형식(decomposed)입니다. 바닐라 아이템 정의 68개도 전부 이 형식만 씁니다 — 16-float 행렬 형식은 row/column-major가 문서화돼 있지 않아 쓰지 않습니다.

```json
"transformation": {
  "translation":   [x, y, z],
  "left_rotation": [qx, qy, qz, qw],
  "scale":         [sx, sy, sz],
  "right_rotation": [0, 0, 0, 1]
}
```

> ⚠️ **네 필드가 전부 필수입니다.** 항등인 필드를 생략하면 클라이언트가 통째로 거부합니다:
> ```
> Couldn't parse item model 'fpa:minimal': No key right_rotation in MapLike[{...}]
> ```
> 바닐라 아이템 정의들이 `left_rotation:[0,0,0,1]` 같은 항등값까지 다 적어놓은 게 스타일이 아니라 강제입니다. (26.3-snapshot-5에서 실측)

`transformation` **필드 자체**는 optional이라, 전체가 항등이면 필드를 통째로 생략합니다. `right_rotation`은 항상 항등으로 내보냅니다 — shear가 없으면 필요 없고, shear는 어차피 표현 불가라 감지 시 경고만 냅니다.

## 크기

프레임당 (움직이는 본 개수)개의 `minecraft:model` 노드가 생깁니다.

```
노드 수 ≈ 애니메이션마다 (프레임 수 × 움직이는 본 수)
```

프레임 수는 **틱 수 + 1**로 자동 결정됩니다 — 그 이상은 클라이언트가 선택할 수 없는 죽은 entry이기 때문입니다 ([clocks.md](clocks.md) 참고). 예제 `pistol`: fire 9프레임 + reload 29프레임, 본 3개 → 약 68노드, 들여쓰기 포함 30KB대. 20fps × 2초 × 본 6개면 240노드 정도이니 긴 애니메이션은 `Max frames`로 자르는 게 좋습니다.

절약 장치 두 개가 이미 들어있습니다.

- 지오메트리는 본마다 **한 번만** 저장 (프레임마다 복제하지 않음)
- 해당 애니메이션에서 **한 번도 안 움직이는 본**은 dispatch 바깥에 한 번만 등장

## 아이템 쪽 컴포넌트

```
minecraft:item_model      = "<ns>:<item>"       ← 이 정의 파일을 가리킴
minecraft:use_cooldown    = {seconds: <애니메이션 길이>, cooldown_group: "<ns>:<item>"}
minecraft:custom_model_data = {strings: ["<애니메이션 이름>"], flags: [<쿨다운 바 표시 여부>]}
```

`seconds`가 애니메이션 길이와 다르면 재생 속도가 그만큼 달라집니다 — 이건 버그가 아니라 **기능**입니다. 같은 팩으로 슬로모션/배속을 만들 수 있습니다.

쿨다운을 거는 건 "아이템 사용이 성공"할 때입니다. 예제는 goat horn을 base로 씁니다(우클릭 항상 성공, 소모 안 됨, `instrument`를 무음으로 덮어씀). 서버 플러그인이 있다면 `player.setCooldown(...)`으로 원하는 시점에 재생을 트리거하면 됩니다.
