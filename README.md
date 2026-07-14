# 아이온2 공식 패치노트 Discord 봇

아이온2 공식 업데이트 게시판을 주기적으로 확인하고, 새 글을 Discord 채널에
**제목 + 공식 이미지 + 내용 일부 + 원문 링크** 형태의 임베드로 전송합니다.

공식 감시 주소:

- https://aion2.plaync.com/ko-kr/board/update/list

## 필요한 환경변수

| 이름 | 설명 |
|---|---|
| `DISCORD_TOKEN` | Discord 개발자 포털에서 발급한 봇 토큰 |
| `DISCORD_CHANNEL_ID` | 패치노트를 올릴 텍스트 채널 ID |
| `CHECK_INTERVAL_MINUTES` | 확인 주기. 기본값 10분 |
| `PORT` | Render가 사용하는 포트. 보통 직접 지정하지 않아도 됨 |

## 봇에 필요한 채널 권한

- 채널 보기
- 메시지 보내기
- 링크 임베드
- 메시지 기록 보기

## 로컬 실행

1. Node.js 20 설치
2. 이 폴더에서 `npm install`
3. `.env.example`을 참고해 환경변수 설정
4. `npm start`

## Render 배포

1. 이 폴더 전체를 GitHub 저장소에 업로드
2. Render에서 **New → Blueprint** 또는 **New → Web Service**
3. GitHub 저장소 연결
4. 환경변수 `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID` 입력
5. 배포

`render.yaml`이 포함되어 있어 Blueprint 방식으로도 배포할 수 있습니다.

## 주의

- 봇 토큰은 절대 채팅, 스크린샷, GitHub 공개 저장소에 올리지 마세요.
- 공식 홈페이지 구조가 크게 변경되면 게시글 추출 부분을 수정해야 할 수 있습니다.
