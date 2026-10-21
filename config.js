/* 집필실 설정 — 직접 배포(포크)할 때는 이 파일만 고치면 돼요.
 * DEFAULT_CLIENT_ID: 구글 OAuth 클라이언트 ID (웹 애플리케이션 · 공개 값이라 비밀이 아님).
 *   비워 두면 사용자가 앱 [설정 → OAuth 클라이언트 ID] 칸에 자기 ID를 넣어 써요 (기기에 저장, 그 값이 우선).
 *   아래 기본 ID는 원래 배포 주소(OWNER_HOST)에서만 쓰이고, 포크한 사이트에서는 자동으로 빈칸이 돼요.
 * 클라이언트 보안 비밀(secret)은 절대 넣지 마세요 — 이 앱은 사용하지 않습니다.
 */
(() => {
  const OWNER_HOST = "lee860506-tech.github.io";
  const own = location.hostname === OWNER_HOST;
  window.YW_CONFIG = {
    DEFAULT_CLIENT_ID: own ? "267218184122-crifk7k2cb4qb3tbd6bq57al13kpmh52.apps.googleusercontent.com" : "",
    DRIVE_ROOT_NAME: "집필실",
    SCOPE: "https://www.googleapis.com/auth/drive.file",
    REPO: "lee860506-tech/jipilsil",        // 안내 링크·APK·릴리스 주소에 쓰여요 (포크하면 내 저장소로)
    LEGACY_PEN_NAME: own ? "연월" : "",      // 이 업데이트 전부터 쓰던 기기에만 한 번 채워 넣는 필명 (새 사용자는 빈칸)
  };
})();
