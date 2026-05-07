# Agent Builder Setup: Libar Pilot Agent

Ovaj vodič je za interni ili pilot agent unutar Microsoft 365. Nije zamjena za javni web bot.

## 1. Otvori Agent Builder

1. Otvori `microsoft365.com/chat`.
2. Klikni `New agent`.
3. Ako ti nudi opisni početak, odaberi `Skip to configure`.

## 2. Osnovne postavke

1. Naziv: `Libar Asistent`
2. Description:
   kopiraj iz `docs/copilot/libar-agent-builder-description.txt`
3. Instructions:
   kopiraj iz `docs/copilot/libar-agent-builder-instructions.txt`

## 3. Gdje je picker / upload

Ako picker ne vidiš u desnom `Configure` panelu, koristi donji chat composer:

1. Klikni **plus** gumb u chat boxu.
2. Traži jednu od opcija:
   - `Add work content`
   - `Attach cloud files`
   - `Upload files`

To je najčešće mjesto gdje Agent Builder sakrije picker.

## 4. SharePoint URL pravila

Ako unosiš URL:

- koristi clean site, folder ili file URL
- nemoj koristiti `Forms/AllItems.aspx?...`
- nemoj koristiti URL s query parametrima

Primjere pogledaj u:

- `docs/copilot/sharepoint-url-guide.md`

## 5. Što napraviti ako traži licencu

Ako dobiješ poruku da je potrebna `Microsoft 365 Copilot license`:

1. tretiraj to kao licencni blok
2. ne pokušavaj dalje debugirati URL
3. prijeđi na `Upload files directly from your device`

## 6. Upload knowledge basea

1. Pokreni lokalno:

   ```bash
   ./scripts/build-copilot-upload-bundle.sh
   ```

2. U Agent Builder uploadaj dokumente iz:

   `dist/copilot-upload-bundle/docx/`

Ako upload `.docx` ne želiš koristiti, Agent Builder podržava i `.txt`, pa možeš uzeti:

`dist/copilot-upload-bundle/txt/`

## 7. Starter prompts

Dodaj promptove iz:

- `docs/copilot/starter-prompts.txt`

## 8. Test

Provjeri:

- `Kako kupiti udžbenike?`
- `Kako prodati udžbenike?`
- `Koji su načini plaćanja?`
- `Koliki je rok dostave?`
- `Kako mogu kontaktirati podršku?`

## 9. Ograničenje Agent Buildera

Agent Builder je dobar za:

- interni proof of concept
- mali timski agent
- M365 pilot

Agent Builder nije pravi put za:

- javni web customer-support deployment
- višekanalnu objavu
- ozbiljnije topic flowove i kanalnu integraciju

Za to koristi `Copilot Studio`.
