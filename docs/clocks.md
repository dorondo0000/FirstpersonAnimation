# 재생 클럭 — 뭘 쓸 것인가

`range_dispatch`가 읽을 수 있는 숫자 프로퍼티가 애니메이션의 "재생 헤드"입니다. 26.3-snapshot-5 클라이언트 jar의 `RangeSelectItemModelProperties.class`에서 **전체 목록을 그대로 뽑았습니다.**

```
bundle/fullness   compass   cooldown   count   crossbow/pull
custom_model_data   damage   time   use_cycle   use_duration
```

## gametime은 없습니다

`minecraft:time`의 소스는 `Time$TimeSource` enum에 세 개뿐입니다.

```
daytime   moon_phase   random
```

즉 **raw 게임틱 카운터를 읽는 방법은 없습니다.** (`Time.class`에 `getGameTime` 참조가 있지만 그건 wobbler 갱신 주기 판정용이지 소스가 아닙니다.)

자유 구동 클럭에 가장 가까운 건 `daytime` 하나이고, 주기가 **24000틱 = 실시간 20분**입니다. 미묘한 아이들 루프에는 쓸 만하고, 동작 애니메이션에는 못 씁니다.

`local_time` select도 확인해봤는데, `LocalTime.class`에 `UPDATE_INTERVAL_MS` + `TimeUnit.SECONDS`가 있습니다 — **1초에 한 번만 갱신**됩니다. 클럭으로 못 씁니다.

## 후보 비교

| 프로퍼티 | 값 | 해상도 | 트리거 | 서버 필요 | 용도 |
|---|---|---|---|---|---|
| **`cooldown`** | 1.0 → 0.0 (남은 양) | 틱 (20fps) | 아이템 사용 성공 | ✗ | **1회성 동작** (발사, 스윙, 재장전) |
| **`use_duration`** | 사용 경과 틱 (↑) | 틱 (20fps) | 우클릭 홀드 | ✗ | **홀드 동작** (조준, 활 당기기) |
| `use_cycle` | `period` 주기 톱니파 | 틱 | 우클릭 홀드 | ✗ | 사용 중 무한 루프 |
| `time` (daytime) | 0.0 → 1.0 / 24000틱 | 틱 | 없음 (상시) | ✗ | 아주 느린 아이들 |
| **`custom_model_data`** (floats) | 임의 0~1 | 틱 | **없음 — 코드가 직접 씀** | 데이터팩 or 플러그인 | **우클릭 없이 임의 시점 재생** |
| `damage` / `count` | 내구도 / 개수 | — | 서버 | **✓** | 부작용 큼, 비추 |
| `crossbow/pull` | 0.0 → 1.0 | 틱 | 석궁 전용 | ✗ | 석궁만 |
| `compass` | 나침반 각도 | 틱 | — | ✗ | `wobble`이 물리 감쇠 진동 |
| `bundle/fullness` | 0.0 → 1.0 | — | — | ✗ | 클럭 아님 |

## cooldown이 1회성 동작에 최선인 이유

1. **정규화 0~1.** `scale` 계산이 필요 없습니다.
2. **정규화된 유일한 트리거형 클럭.** 다른 트리거형(`use_duration`, `use_cycle`)은 틱 수를 그대로 돌려주므로 `scale`로 나눠야 하지만, cooldown은 그냥 0~1입니다.
3. **속도가 데이터.** 재생 속도가 `use_cooldown.seconds`에 있습니다. 같은 팩으로 아이템마다 슬로모션/배속을 만들 수 있습니다.
4. **트리거가 순수 바닐라.** 우클릭 성공 = 재생 시작. 서버 코드 0.

## cooldown의 진짜 단점

- **쿨다운 중에는 아이템을 못 씁니다.** 총이라면 원하는 동작이지만, "재장전 모션만 보여주고 싶다" 같은 경우엔 강제 부작용입니다.
- **플레이어당 `cooldown_group` 하나.** 같은 그룹이면 동시에 두 애니메이션 불가.
- **핫바에 오버레이가 뜹니다.** 그래서 코어 셰이더가 필요합니다 ([README](../README.md) 4-5).
- 아이템이 "사용 가능"해야 합니다. 예제는 goat horn을 씁니다.

## use_duration이 나은 경우

홀드 동작이면 `use_duration`이 명백히 낫습니다.

- 떼는 즉시 0으로 복귀 → 복귀 애니메이션을 따로 안 만들어도 됩니다 (역재생이 공짜)
- 쿨다운이 안 걸리므로 아이템이 계속 사용 가능
- 핫바에 아무것도 안 뜨므로 **코어 셰이더가 아예 필요 없습니다**

대신 **방향이 반대**입니다. cooldown은 1→0이라 마지막 키프레임이 대기 포즈지만, use_duration은 0부터 올라가므로 **첫 키프레임이 대기 포즈**여야 합니다. 플러그인이 클럭 설정에 따라 자동으로 맞춥니다.

예제 팩의 `fpa:aim`이 이 방식입니다.

```
/give @s minecraft:stick[minecraft:item_model="fpa:aim",minecraft:consumable={consume_seconds:3600,animation:"none",has_consume_particles:false,sound:"minecraft:intentionally_empty"},minecraft:custom_model_data={strings:["aim"]}]
```

`consume_seconds: 3600`이라 절대 완료되지 않으므로 우클릭을 무한정 홀드할 수 있습니다.

## 우클릭 없이 트리거하기

**바닐라 커맨드로는 쿨다운을 걸 수 없습니다.** 클라이언트 jar의 `net/minecraft/server/commands/`에 쿨다운 관련 클래스가 하나도 없고, `ItemCooldowns.addCooldown()`은 서버 Java API 전용입니다. 그래서 두 경로가 있습니다.

### 1. 플러그인 (Paper / Spigot / Folia) — `clock = cooldown`

```java
player.setCooldown(itemStack, 8);   // 8틱 = 0.4초짜리 fire 애니메이션
```

이게 제일 깔끔합니다. **아이템에 `use_cooldown` 컴포넌트도, 사용 가능한 base item도 필요 없습니다** — `minecraft:item_model`만 붙어 있으면 됩니다. 우클릭이든 스킬 발동이든 스케줄러든 원하는 시점에 호출하면 그 순간부터 재생됩니다.

> ⚠️ `Material` 오버로드가 아니라 **`ItemStack` 오버로드**를 쓰세요. 쿨다운은 `cooldown_group` 단위로 키가 잡히는데(`ItemCooldowns.getCooldownGroup`), `use_cooldown.cooldown_group`을 지정한 아이템은 `Material` 오버로드가 엉뚱한 그룹을 건드립니다.

재생 해상도는 다른 클럭과 동일한 20fps입니다 (아래 참고).

### 2. 데이터팩만 — `clock = custom_model_data`

프레임 인덱스를 `custom_model_data.floats[i]`에서 직접 읽습니다. 트리거가 아예 없고, **코드가 0.0 → 1.0을 써주는 게 곧 재생**입니다.

```
/item modify entity @s weapon.mainhand <ns>:<modifier>
```

`minecraft:set_custom_model_data` 아이템 모디파이어 함수가 26.3에 실재합니다(`LootItemFunctions`에서 확인). 필드는 `floats` / `flags` / `strings` / `colors`.

단점이 분명합니다.

- **틱당 아이템 재작성 1회** → 네트워크·GC 비용. 긴 애니메이션 여러 개를 동시에 돌리면 부담됩니다.
- 20fps 상한 (틱 단위)
- 서브틱 보간 없음

정확한 스키마 (rieyi/display-anim-preview의 동작하는 데이터팩에서 확인):

```json
{
  "function": "minecraft:set_custom_model_data",
  "floats": {
    "values": [{ "type": "minecraft:score", "target": "this", "score": "<objective>" }],
    "mode": "replace_all"
  }
}
```

리스트 래퍼는 `{ values, mode }`이고, `values`에 number provider를 넣을 수 있어서 **스코어보드 값을 그대로 프레임 인덱스로** 쓸 수 있습니다.

## 클럭이 아닌 것도 하나: `keybind_down`

`ConditionalItemModelProperties`에 **`keybind_down`**이 있습니다 (`IsKeybindDown.class` → `KeyMapping.isDown()`). 불리언이라 클럭은 아니지만, **키 상태를 클라이언트에서 즉시** 읽습니다 — 서버 왕복 0, 지연 0. 조준 on/off처럼 즉시 전환에는 애니메이션보다 이게 맞습니다.

```json
{ "type": "minecraft:condition", "property": "minecraft:keybind_down",
  "keybind": "key.use",
  "on_true":  { "...": "조준 포즈" },
  "on_false": { "...": "기본 포즈" } }
```

`use_duration`(부드러운 전환) 과 `keybind_down`(즉시) 을 조합하는 것도 가능합니다.

## 검증 수준

| 항목 | 상태 |
|---|---|
| 프로퍼티 전체 목록, `TimeSource` 값 | jar에서 직접 확인 |
| `cooldown` 방향 | `getCooldownPercent(ItemStack,F)F` 호출로 확인 |
| **모든 클럭 20fps 상한** | javap 디스어셈블: `Cooldown.get()`이 `fconst_0`으로 partialTick=0을 넘김, `UseDuration.get()`은 `getUseItemRemainingTicks():I` + `i2f` |
| **20fps 상한 인게임 실증** | 60틱 쿨다운에 entry 180개(포즈 3종 순환)를 넣는 판별 프로브. 양자화면 3의 배수 인덱스만 도달 → 중립 포즈로 완전 정지. 실제로 정지함 = 나머지 119개는 죽은 entry |
| **프레임 예산은 타임라인이 아니라 쿨다운** | `getCooldownPercent` 분모가 `endTime - startTime` = 쿨다운 길이. 1초 애니메이션에 2초 쿨다운 → 41단계 |
| `use_duration` 필드(`remaining`)·int 소스 | `UseDuration.class`에서 확인 |
| `local_time` 1초 스로틀 | `UPDATE_INTERVAL_MS` + `TimeUnit.SECONDS` |
| **`use_cycle`의 정확한 모듈로 의미** | **미확인** — `period` 필드와 `getUseItemRemainingTicks` 사용만 확인. 플러그인 옵션으로는 넣어뒀지만 인게임에서 확인하고 쓰세요 |
| `daytime`의 `wobble:false` 정확도 | 미확인 |
