## What and why

<!-- A few plain sentences. Link the issue or decision if there is one. -->

## Checklist

- [ ] Tests pass locally: `npm run typecheck`, `npm run test -w server` and `npm run build`
- [ ] New or changed behaviour has tests
- [ ] No secrets, keys, `.env` files or real patient data (names, case numbers, STL, PTS, CSV or zip files) in the code, tests, docs or screenshots
- [ ] Documentation is updated (`README.md`, `docs/`, the API guides, the contract documents) where behaviour changed
- [ ] Security impact considered (sign in, access control, encryption, uploads, logging, new dependencies): see below
- [ ] A migration is included for any database change (new numbered file in `server/migrations/`, never edit an applied one)

## Security impact

<!-- None, or describe what changes and how it is protected. -->

## How to check it

<!-- Steps for the reviewer. -->
