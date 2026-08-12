# Firstperson Animation

**Blockbench에서 1인칭 아이템 애니메이션을 만들어 순수 리소스팩으로 굽는 툴.** 서버에서 쓰는 걸 전제로 합니다.

26.1 snapshot 11에서 item model definition에 `transformation`이 추가됐고, `minecraft:range_dispatch`가 `minecraft:cooldown`(1.0→0.0)을 읽습니다. 이 둘을 합치면 **바닐라 아이템 쿨다운이 그대로 애니메이션 재생 헤드**가 됩니다.

## 서버가 하는 일은 3개뿐

```
minecraft:item_model      →  어느 모델 정의를 쓸지
minecraft:custom_data     →  어느 애니메이션인지 (키 하나에 문자열)
바닐라 아이템 쿨다운       →  재생 헤드
```

**base item 제약 없음** — 아무 아이템이나 됩니다. 데이터팩 없음, 커맨드 없음, `use_cooldown` 컴포넌트도 불필요. `assets/minecraft`에 아무것도 안 씁니다.

```skript
function fpa_pistol_fire(p: player):
    set {_i} to {_p}'s tool
    set string tag "{@anim}" of custom nbt of {_i} to "fire"
    set {_p}'s tool to {_i}
    set item cooldown of {_i} for {_p} to 8 ticks
```

export하면 이 Skript 파일이 팩에 같이 들어갑니다 (지급 / 쿨다운표시 온오프 / 애니메이션 재생 함수).

---

## 구조

```
FirstpersonAnimation/
├─ plugin/firstperson_animation.js   Blockbench 플러그인 (단일 파일)
├─ examples/
│  ├─ fpa_examples/                  완성 예제 팩 (+ .sk)
│  ├─ bbmodel/                       예제 소스 (Blockbench에서 열기)
│  └─ cooldown_hider/                코어셰이더 서브팩 — 선택, 별도 팩
├─ tools/
│  ├─ make_examples.mjs              예제 생성기 = 출력 포맷 레퍼런스
│  ├─ make_cooldown_hider.ps1        내 클라 jar에서 gui.fsh 패치
│  └─ cooldown_discard.glsl          수동 패치용 스니펫
└─ docs/
   ├─ output-format.md               생성되는 JSON 구조
   └─ clocks.md                      왜 cooldown인지 + 20fps 천장 근거
```

## 사용법

1. `File > Plugins > Load Plugin from File` → `plugin/firstperson_animation.js`
2. `File > New > Firstperson Animation`
3. **그룹 = 본 = 모델 파일 하나.** 움직일 단위마다 그룹을 만들고 큐브를 넣습니다
4. `Display` 모드에서 `First person right hand`를 잡습니다. **모델은 -Z를 향하게** (총구가 낮은 z)
5. `View > First Person Camera (Right Hand)` → 뷰포트가 **인게임 1인칭 프레이밍**으로 이동. 이 상태로 애니메이션 작성
6. `Animate` 모드에서 작성
   - **애니메이션 이름 = `custom_data`에 넣을 문자열**
   - **마지막 키프레임 = 대기 포즈** (쿨다운이 0일 때 보이는 게 마지막 프레임)
7. `File > Export > Firstperson Animation Settings...` → 네임스페이스/아이템 이름
8. `File > Export > Export Firstperson Animation Pack` → zip (팩 + `<ns>_<item>.sk` + README)

---

## 핵심 설계

### 클럭은 `cooldown` 하나

`minecraft:cooldown`은 **남은 쿨다운**을 돌려줍니다. 걸린 순간 1.0, 끝나면 0.0.

- 진행도 = `1 - cooldown` → 프레임 0이 발동 순간, **마지막 프레임이 평상시**
- `range_dispatch`는 "값 이하인 마지막 entry"를 고르므로 threshold `j/N` → 프레임 `N-1-j`
- **재생 길이 = 쿨다운 길이.** 같은 팩으로 아이템마다 속도가 달라집니다

### 20fps가 엔진 천장 (검증됨)

`Cooldown.get()`이 `getCooldownPercent`에 partialTick으로 **`0.0F`를 넘깁니다** — 26.1.2 / 26.2 / 26.3 전부 `fconst_0`. 값은 램프가 아니라 **계단**이고 단수는 `쿨다운 틱 + 1`입니다.

세 가지가 일치합니다:
1. 바이트코드 (3개 버전)
2. 인게임 프로브 (60틱에 entry 180개, 3의 배수만 도달 → 완전 정지 확인)
3. 60fps 영상 프레임 측정 (90프레임 중 26프레임만 변화 = 29% ≈ 1/3)

**프레임을 늘리려면 entry가 아니라 쿨다운을 늘려야 합니다.** 툴이 `틱+1`로 자동 계산합니다.

체감 끊김은 fps가 아니라 **스텝당 변화량**이 정합니다. 6°/스텝은 부드럽고, 22°/스텝은 튑니다.

### 본마다 dispatch 하나

순진한 구조는 `range_dispatch → composite(전체 본)` = **프레임 × 본**. 본마다 자기 dispatch를 주면 그 본이 실제로 취하는 포즈 수만큼으로 줄어듭니다.

- 연속 동일 프레임 → entry 1개
- 안 움직이는 본 → dispatch 없이 `minecraft:model` 1개
- 지오메트리는 본마다 파일 하나에 한 번만

예제 실측: **121 → 55 노드 (55% 감소)**

### 애니메이션 분기 = `custom_data` 중첩 condition

`select`의 `minecraft:component`는 컴파운드 **완전일치**라 못 씁니다. 반면 `condition`의 `minecraft:component`는 `DataComponentPredicate` 기반이라 **부분 매칭**입니다 — 서버가 `custom_data`에 뭘 더 넣든 상관없습니다.

```json
{ "type": "minecraft:condition", "property": "minecraft:component",
  "predicate": "minecraft:custom_data",
  "value": { "fpa": "fire" },
  "on_true":  { "...fire...": "" },
  "on_false": { "...다음 애니메이션, 최종적으로 대기 포즈...": "" } }
```

`predicate`는 **타입 id 문자열**, 값은 `value`에 들어갑니다 (`ComponentMatches.MAP_CODEC = DataComponentPredicate.singleCodec("predicate")`). 키가 없거나 매칭 안 되면 대기 포즈입니다.

### 쿨다운 바 (선택)

핫바 오버레이를 모델로 재현합니다. 흰색 알파 127/255 — 바닐라와 같은 색이고, **아이템 텍스처의 부분 알파는 정상 동작합니다**. `custom_data`의 `fpa_bar` 키로 켜집니다.

바닐라 흰 오버레이는 그 위에 계속 그려집니다. 없애려면 **별도 팩**이 필요합니다 (`assets/minecraft`에 있어야 해서 본 팩에 못 넣습니다):

```powershell
.\tools\make_cooldown_hider.ps1 -Jar "...\minecraft-26.3-snapshot-5-client.jar"
```

내 클라의 vanilla `gui.fsh`를 꺼내 `0x7FFFFFFF` discard를 넣습니다. 추측한 셰이더를 배포하지 않습니다.

---

## 26.3 클라 jar에서 실측한 것

| 항목 | 결과 | 근거 |
|---|---|---|
| `transformation` 피벗 | **블록 코너 (0,0,0), 단위=블록** | `black_shulker_box.json`이 `ShulkerBoxRenderer`의 PoseStack 연산과 소수점까지 일치 |
| transformation 필드 | **네 개 전부 필수** | 하나라도 빠지면 `No key right_rotation in MapLike[...]`로 아이템 전체 파싱 실패 |
| `pack.mcmeta` | format 64 초과면 `min_format`/`max_format` **필수** | 없으면 팩 전체 로드 실패 → 전부 미싱 텍스처 |
| 클럭 20fps 천장 | **확정** | `fconst_0` (3개 버전) + 인게임 프로브 + 영상 프레임 측정 |
| 프레임 예산 | 타임라인이 아니라 **쿨다운 틱 + 1** | `getCooldownPercent` 분모가 `endTime - startTime` |
| `custom_data` condition | `predicate`(문자열) + `value`, **부분 매칭** | `singleCodec("predicate")` = `dispatchMap`, `Single`은 `fieldOf("value")`. 인게임 파싱 확인 |
| 아이템 텍스처 부분 알파 | **가능** | 인게임 실측 (jar 구조만 보고 "불가"로 추론했다가 틀렸음) |
| 왼손 미러링 | `translation.x` / `rotation.y` / `rotation.z` 자동 반전 + 프레임 x −0.56 | `ItemTransform.apply` / `ItemInHandRenderer` |

**미검증**: Blockbench 플러그인의 런타임 동작 (여기서 Blockbench를 띄울 수 없음). export 왕복 검증이 남아있습니다.

## 한계

- **보간 없음.** 프레임을 구워 넣습니다. `client/renderer/item` 패키지 전체에 `lerp`가 0건이고, 프로퍼티 인터페이스 `get(ItemStack, ClientLevel, ItemOwner, int)`에 partialTick 파라미터 자체가 없습니다
- **shear 불가.** 회전된 본에 비균등 스케일 → 표현 불가, export 시 경고
- **쿨다운은 `cooldown_group` 단위.** 같은 그룹이면 동시에 두 애니메이션 불가
- **26.1+ 전용**
