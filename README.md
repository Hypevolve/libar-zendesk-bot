# Libar Zendesk Bot

Zendesk-first support bot za Antikvarijat Libar. Backend upravlja web chatom, email/Facebook webhook automacijom, knowledge retrievalom i sigurnim handoffom na ljudsku podrsku.

## Trenutni status

- Aktivan web chat widget (`/chat`) s Zendesk ticket backendom.
- Multi-channel webhook obrada za `email` i `facebook`.
- Knowledge sloj: Zendesk Help Center + OneDrive (+ opcionalni Supabase vector sloj).
- AI policy je konzervativan: kad nema dovoljno siguran odgovor, ide `awaiting_human`.

## Brzi start

1. Kopiraj `.env.example` u `.env` i popuni kljuceve.
2. Pokreni:

```bash
npm install
npm run dev
```

3. Otvori `http://localhost:3000/chat`.

## Testovi

```bash
npm test
```

Dodatni report skripte:

```bash
npm run report:regression
npm run report:real-queries
```

## Dokumentacija

- Kanonska dokumentacija sustava: `BOT_DOKUMENTACIJA.md`
- Operativni runbook: `docs/support-runbook.md`
- QA matrix: `docs/multi-channel-bot-qa.md`
- Smoke checklist prije releasa: `docs/pre-release-smoke-checklist.md`
- Pravila izvora znanja: `docs/knowledge-source-of-truth.md`

## Napomena o verziji dokumentacije

Dokumentacija je uskladena sa stanjem koda na datum **2026-04-29**. Ako mijenjas policy, endpoint contract ili channel flow, azuriraj dokumentaciju u istom PR-u.
