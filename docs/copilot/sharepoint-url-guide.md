# SharePoint URL Guide

## Problematičan URL

Ovo je tip URL-a koji ne treba unositi:

```text
https://dantehr.sharepoint.com/Shared%20Documents/Forms/AllItems.aspx?id=...
```

Zašto je problematičan:

- to je SharePoint `view` URL
- sadrži `Forms/AllItems.aspx`
- sadrži query parametre poput `?id=...`

Takav URL često ne prolazi u Agent Builderu i nije dobar za knowledge source.

## Ispravan oblik URL-a

Koristi jedan od ova tri oblika:

### SharePoint site

```text
https://tenant.sharepoint.com/sites/site-name
```

### SharePoint folder

```text
https://tenant.sharepoint.com/sites/site-name/Shared%20Documents/Libar%20KB
```

### SharePoint datoteka

```text
https://tenant.sharepoint.com/sites/site-name/Shared%20Documents/Libar%20KB/03_dostava_i_placanje.docx
```

## Kako doći do clean URL-a

1. Otvori SharePoint folder.
2. Kroz breadcrumb idi na:
   - site
   - dokument biblioteku
   - točan folder
3. Kopiraj adresu tek kad si na samom folderu ili datoteci, bez `AllItems.aspx` i bez `?id=...`.

## Pravilo za Agent Builder

Ako i clean URL vrati poruku:

`A Microsoft 365 Copilot license is required for SharePoint sites`

onda je problem licenca, ne URL. U tom slučaju koristi:

- `Upload files`
- ili `Copilot Studio` s ručnim uploadom dokumenata
