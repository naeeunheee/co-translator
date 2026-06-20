# SECURITY_DEPLOY_CHECKLIST.md

# Co-Translator 배포 전 보안 점검표

이 저장소는 public 상태이므로 실제 키, 고객 데이터, 내부 설정을 절대 커밋하지 않는다.

## 배포 전 필수 확인

```txt
[ ] .env / .env.local / .env.production 미커밋
[ ] API Key / service_role / private key 미커밋
[ ] 개인정보 / 고객 데이터 / 통역 로그 원본 미포함
[ ] Supabase RLS 적용 확인
[ ] GitHub public 상태 재확인
[ ] Vercel/Netlify 환경변수 분리 확인
[ ] 배포 로그에 키 출력 없음 확인
```

---

## 금지 파일

```txt
.env
.env.*
*.env
*.pem
*.key
*credentials*.json
*service-account*.json
*.sql
*.dump
*.sqlite
*.db
```

---

## 허용 파일

```txt
.env.example
```

단, 실제 키 없이 placeholder만 사용한다.

```txt
VITE_SUPABASE_URL=your_supabase_url_here
VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key_here
```

---

## Supabase 원칙

- 프론트엔드에는 publishable/anon key만 사용한다.
- service_role key는 절대 프론트엔드와 public GitHub에 넣지 않는다.
- 사용자 데이터, 통역 로그, 기관 데이터가 들어가는 테이블은 RLS를 켠다.
- 관리자 기능은 서버 또는 Edge Function에서만 처리한다.

---

## 사고 시 조치

키가 노출되면 삭제로 끝내지 않는다.

```txt
1. 노출 파일 삭제
2. 해당 키 즉시 rotate/revoke
3. Vercel/Netlify/Supabase 환경변수 교체
4. commit history 정리 필요성 판단
5. 접근 로그 확인
6. 재발 방지 규칙 업데이트
```

한 번 공개된 키는 이미 노출된 것으로 간주한다.
