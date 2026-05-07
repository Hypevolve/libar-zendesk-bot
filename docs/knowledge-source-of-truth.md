# Knowledge Source of Truth

Datum uskladjenja: 29.04.2026

## Kanonski izvori po domeni

- `product_lookup`: webshop guidance (`/kupi-udzbenike/`) + link fallback
- `buyback`: OneDrive + vector (ako je konfigurirano), Zendesk pomocni izvor
- `support_info` i `delivery`: Zendesk Help Center prioritet
- `order` i reklamacijski support: Zendesk Help Center prioritet

## Merge i prioritet pravila

`knowledgeService` mergea rezultate iz tri izvora:
- vector
- OneDrive lexical
- Zendesk Help Center

Pravila:
1. Kandidati se sortiraju po scoreu.
2. Kod tie-breaka OneDrive entry ima prednost.
3. U kontekst ulazi top `KNOWLEDGE_CONTEXT_ITEMS` kandidata.
4. Ako AI grounded odgovor nije kvalitetan, koristi se deterministic knowledge fallback.

## Policy override pravila

Sljedeca pravila imaju prednost nad retrieval odgovorom:
- `attachments_present` -> handoff
- kriticni complaint signali -> handoff
- `order_issue_clarification` kad nedostaju identifikatori narudzbe
- buyback specific guidance (`online_buyback_guidance`, `buyback_offer_guidance`, `buyback_package_guidance`, itd.)
- product lookup guidance (`purchase_search_guidance`) umjesto direktnog product card odgovora

## Obavezni audit topicovi

- radno vrijeme
- adresa i kontakt
- dostava i rokovi
- status narudzbe i opci order FAQ
- reklamacije i povrati
- buyback / otkup proces
- placanje

## Kada prijaviti knowledge conflict

Prijavi conflict ako se razlikuju cinjenice koje utjecu na customer odgovor:
- cijene
- rokovi
- uvjeti povrata
- kontakt podaci
- operativni koraci buybacka
