# Toast History · 요술봉 기록 패널

SillyTavern 요술봉 메뉴에서 별도의 알림 기록 패널을 여는 확장입니다.

참고: https://github.com/LenAnderson/SillyTavern-ToastHistory
원본 소스나 이미지 자산은 복사하지 않고 독립적으로 작성했습니다.

## 주요 기능
- 요술봉 → 알림 기록 패널 열기 / 닫기
- 상단 종 아이콘 (기록이 있을 때 표시)
- 정보·성공·경고·오류 알림 수집 및 브라우저 로컬 저장 (최근 400개)
- 검색, 종류 필터, 개별 또는 보이는 기록 전체 복사, 기록 비우기
- 동일한 알림의 *기록 수집만* 차단 및 해제 (팝업 알림 자체는 표시)
- 세션 중 알림 onclick 동작이 있는 경우 원래 동작 버튼
- 데스크톱에서 패널 크기 조절

## 설치 방법
1. SillyTavern → Extensions → Install extension
2. Git repository URL: https://github.com/ggang55158891-dev/ST-Message-Navigator
3. Branch name: toast-history-wand-panel (필수!)
4. Install 후 SillyTavern 새로고침

중요: 이 코드는 ST-Message-Navigator 저장소의 **독립 브랜치**에 있습니다.
기본 브랜치 main은 메시지 네비게이터이므로 설치 시 브랜치 이름을 꼭 입력하세요.

## 주의
- 실제 브라우저에서의 동작 테스트는 별도로 필요합니다.
- 원본 ToastHistory와 함께 켜면 기능 및 아이콘이 중복될 수 있습니다.
- 설치 전에 지나간 알림은 불러오지 않으며 원본 확장 데이터도 자동 이전하지 않습니다.
- HTML 메시지는 안전을 위해 텍스트로 저장됩니다.
- 알림에 민감한 정보가 포함될 수 있습니다. 브라우저 localStorage를 공유하지 마세요.
- 저장된 기록은 다른 브라우저와 동기화되지 않습니다.
