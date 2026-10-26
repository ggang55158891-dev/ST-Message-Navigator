# Message Navigator & Outline for SillyTavern

SillyTavern용 메시지 네비게이션 확장 (v1.0.0)

## 설치 (Windows 11 포함)

1. `st-message-navigator.zip`을 압축 해제합니다.
2. 압축 내의 **`st-message-navigator` 폴더 전체**를 SillyTavern 설치 폴더의 다음 위치에 복사합니다.
   `SillyTavern/public/scripts/extensions/third-party/st-message-navigator/`
   - `manifest.json` 파일이 위 폴더 바로 아래에 있어야 합니다.
3. SillyTavern을 새로고침합니다. **오른쪽(기본값)에 다섯 개의 원형 버튼**이 나타납니다.
4. 확장 설정(Extensions 패널)의 `Message Navigator & Outline (메시지 탐색)` 항목에서 이동 범위와 버튼 위치를 선택합니다.

설치가 안 되면 `F12 → Console`에서 `[ST Message Navigator]` 메시지를 확인하세요.

## 버튼 (위에서 아래)

1. 첫 메시지로 이동
2. 이전 메시지로 이동
3. 채팅 개요(목차) 열기/닫기
4. 다음 메시지로 이동
5. 마지막 메시지로 이동

* **모든 메시지:** `is_system === true`로 숨김 처리된 메시지도 이동 대상에 포함합니다.
* **숨김 메시지 제외:** 앞/뒤 네비게이션에서 숨김 메시지를 건너뜁니다. 개요 패널에서는 숨김 메시지도 흐리게 표시하며 직접 클릭해서 이동할 수 있습니다.
* 목차에서 제목을 클릭하면 해당 메시지로 이동합니다. 제목 옆 연필 버튼으로 **제목만** 수정합니다. 원문 메시지 내용은 변경되지 않습니다.
* 제목을 공백으로 저장하면 자동 제목으로 돌아갑니다.
* 목차 검색창에서는 제목·본문 앞부분·발화자 이름을 검색할 수 있습니다.

## 저장 및 브랜치

* 제목은 **채팅별 메타데이터**(`chatMetadata.stmn_message_outline_v1.titles`)에 저장됩니다.
* 제목을 수정한 메시지에만 `stmn_message_id_v1`라는 고유 식별자 필드가 생깁니다. `mes` 본문과 `extra` 필드는 변경하지 않습니다.
* 일반적인 SillyTavern 브랜치/체크포인트는 메시지와 채팅 메타데이터를 복사하므로, **브랜치를 만든 시점까지 존재하던 제목**이 함께 복제됩니다. 이후 원본 채팅과 브랜치는 각각 독립적으로 수정할 수 있습니다.
* **이미 존재하는 브랜치로 변경 사항을 실시간 동기화하지는 않습니다.**
* 실리태번 내장 저장 API를 사용합니다. 채팅 파일(.jsonl)을 다른 프로그램에서 편집한다면 백업을 먼저 준비하세요.

## 호환성과 한계

* SillyTavern **release 최신 소스**의 `getContext()`, `showMoreMessages()` 및 DOM 구조를 바탕으로 작성되었습니다.
* 다른 확장의 CSS/DOM이나 실리태번 내부 전역 변수를 수정하지 않습니다. UI 이벤트와 확장 전용 데이터 키를 사용합니다.
* 과거 메시지가 화면에 없으면 ST의 자체 렌더러로 180개씩 추가 로딩합니다. 채팅이 매우 길면 첫 메시지로 이동할 때 다소 느려질 수 있습니다.
* SillyTavern이 자체 DOM 구조나 내부 `showMoreMessages` export를 변경하는 경우 호환성 수정이 필요할 수 있습니다(버튼 클릭 경로로 보조 폴백 제공).
* 앱이 직접 다른 메시지 객체를 복제하면서 기존 확장 식별자까지 복사한 경우, 해당 복제본 제목을 새로 저장할 때 식별자를 분리합니다.
* `is_system`은 ST의 숨김 플래그이며, CSS `display:none`으로 강제로 숨긴 메시지는 스크롤할 수 없습니다.
* 다량의 영상/이미지, Stream 중 DOM 변경, 스와이프 플러그인 동시 구동 등 환경 차이에 따라 실제 동작 검증이 필요합니다.
* 이 배포본은 **코드 문법 검사 및 모의 데이터 단위 테스트**를 통과했지만, 사용자의 SillyTavern 설치 환경에 접속해 통합 테스트한 것은 아닙니다.

## 개발 및 테스트

`node --experimental-default-type=module --test tests/*.test.mjs`

코드 구성: `index.js`(초기화), `model.js`(탐색/제목/저장), `scroll.js`(ST 메시지 로딩), `ui.js`(버튼/개요/설정), `style.css`(전용 스타일).
