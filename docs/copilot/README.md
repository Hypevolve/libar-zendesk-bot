# Libar Copilot Paket

Ovaj direktorij sadrži gotove artefakte za dva Microsoft alata:

- `Copilot Studio` za javni customer-support bot na webu
- `Agent Builder` za interni ili pilot agent unutar Microsoft 365

## Što je uključeno

- `copilot-studio-setup.md`:
  korak-po-korak vodič za javni bot u Copilot Studio
- `agent-builder-setup.md`:
  korak-po-korak vodič za Agent Builder i objašnjenje gdje se nalazi upload/picker
- `sharepoint-url-guide.md`:
  kako izgleda ispravan SharePoint URL i zašto `Forms/AllItems.aspx?...` ne prolazi
- `libar-copilot-studio-system-prompt.md`:
  gotov system prompt za Copilot Studio
- `libar-agent-builder-description.txt`:
  kratki opis za Agent Builder
- `libar-agent-builder-instructions.txt`:
  kraće upute za Agent Builder
- `starter-prompts.txt`:
  conversation starters za oba alata
- `fallback-topics.md`:
  gotovi tekstovi za ručne topic-e u Copilot Studio
- `zendesk-ticket-custom-connector-flat.yaml` / `.json`:
  gotov OpenAPI custom connector s dvije operacije: kreiranje ticketa i dodavanje komentara (agent reply)
- `zendesk-ticket-custom-code.cs`:
  custom code koji transformira flat inpute u Zendesk API payloade za obje operacije
- `knowledge-base/*.txt`:
  upload-ready knowledge base dokumenti

## Preporučeni workflow

1. Najprije koristi `Copilot Studio` za javni bot.
2. `Agent Builder` koristi samo kao interni test ili mali pilot unutar Microsoft 365.
3. Knowledge base održavaj u SharePointu kao source of truth, ali za javni v1 bot uploadaj ove dokumente ručno.
4. Ako kasnije potvrdiš Microsoft 365 Copilot licencu i želiš interni agent, možeš testirati i SharePoint grounding u Agent Builderu.

## Generiranje upload bundlea

Za izradu `.docx` bundlea pokreni:

```bash
./scripts/build-copilot-upload-bundle.sh
```

Skripta generira:

- `dist/copilot-upload-bundle/txt/`
- `dist/copilot-upload-bundle/docx/`
- `dist/libar-copilot-upload-bundle.zip`

## Redoslijed uploadanja u Copilot Studio

1. `knowledge-base/05_kontakt_i_radno_vrijeme`
2. `knowledge-base/03_dostava_i_placanje`
3. `knowledge-base/01_kupnja_i_pretraga_udzbenika`
4. `knowledge-base/02_otkup_udzbenika`
5. `knowledge-base/04_narudzbe_reklamacije_i_povrati`
6. `knowledge-base/06_program_vjernosti_i_popusti`
7. `knowledge-base/07_uvjeti_i_privatnost`

## Napomena o izvorima

Sadržaj u knowledge-base datotekama temelji se na:

- javno dostupnim stranicama `antikvarijat-libar.com`
- postojećem bot knowledge sloju i regresijskim fixture-ima u ovom repo-u

Ako se javni webshop podaci promijene, prvo ažuriraj `docs/copilot/knowledge-base/*.txt`, a zatim ponovno pokreni build skriptu.
