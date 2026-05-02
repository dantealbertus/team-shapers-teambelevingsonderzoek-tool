# TeamBelevingsonderzoek — Deployment Guide

## Wat je nodig hebt
- Een GitHub account
- Een Railway account (gratis tier volstaat): railway.app
- Een Anthropic API sleutel: console.anthropic.com

---

## Stap 1 — Repository aanmaken op GitHub

1. Ga naar github.com → klik **New repository**
2. Naam: `teambelevingsonderzoek`
3. Visibility: **Private** (aanbevolen)
4. Klik **Create repository**

Upload de bestanden:
```
teambelevingsonderzoek/
├── server.js
├── package.json
├── .gitignore
├── .env.example
└── public/
    └── index.html   ← jouw teambelevingsonderzoek.html hernoemd naar index.html
```

---

## Stap 2 — Railway project aanmaken

1. Ga naar **railway.app** → klik **New Project**
2. Kies **Deploy from GitHub repo**
3. Verbind je GitHub account en selecteer `teambelevingsonderzoek`
4. Railway detecteert automatisch Node.js en start de deploy

### Database toevoegen
5. In je Railway project: klik **+ New** → **Database** → **PostgreSQL**
6. Railway voegt automatisch `DATABASE_URL` toe aan je environment

---

## Stap 3 — Environment variables instellen

In Railway → je service → **Variables** tab, voeg toe:

| Variable | Waarde |
|----------|--------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (van console.anthropic.com) |
| `ADMIN_PASSWORD` | Kies een sterk wachtwoord |
| `ADMIN_SESSION_TOKEN` | Willekeurige string, bijv. 32 tekens |
| `DATABASE_URL` | Wordt automatisch ingesteld door Railway |

---

## Stap 4 — index.html klaarmaken

Hernoem `teambelevingsonderzoek.html` naar `index.html` en zet het in de `public/` map.

**Belangrijk:** De frontend communiceert nu via de backend API. Als je de huidige HTML gebruikt, werkt localStorage nog. Voor de volledige multi-user ervaring zie "Volgende stap" hieronder.

---

## Stap 5 — Deploy

Zodra je de bestanden naar GitHub pusht, deploy Railway automatisch. Je krijgt een URL zoals:
```
https://teambelevingsonderzoek-production.up.railway.app
```

### Controleer of het werkt:
- Open de URL → je ziet het inlogscherm
- Admin login: gebruik het wachtwoord dat je in `ADMIN_PASSWORD` hebt ingesteld
- AI-adviezen: werken nu via de server (sleutel is veilig)

---

## Optioneel: eigen domein

In Railway → je service → **Settings** → **Custom Domain**:
- Voeg toe: `onderzoek.teamshapers.nl`
- Volg de DNS-instructies (CNAME record toevoegen bij je domeinbeheerder)

---

## Volgende stap: volledig multi-user

De huidige HTML gebruikt nog localStorage. Voor echte multi-user (meerdere browsers/devices):
- Antwoorden van deelnemers gaan naar de database via `/api/answers`
- Admin-data komt van de database via `/api/admin/*`

Vraag Team Shapers (of Claude) om de frontend om te bouwen naar API-calls.
De backend is al volledig klaar — alle endpoints zijn beschikbaar.

---

## API overzicht

### Publiek (geen auth)
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| POST | `/api/participant/login` | Deelnemer inloggen met code |
| GET | `/api/questions` | Actieve vragen ophalen |
| POST | `/api/answers` | Antwoorden opslaan |
| POST | `/api/answers/complete` | Vragenlijst afronden |

### Admin (vereist `x-admin-token` header)
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| POST | `/api/admin/login` | Admin inloggen |
| GET | `/api/admin/organisations` | Alle organisaties + teams + deelnemers |
| POST/DELETE | `/api/admin/organisations/:id` | Org aanmaken/verwijderen |
| POST/DELETE | `/api/admin/teams/:id` | Team aanmaken/verwijderen |
| POST/DELETE | `/api/admin/participants/:id` | Deelnemer aanmaken/verwijderen |
| GET/POST/PUT/DELETE | `/api/admin/questions` | Vragen beheren |
| POST/DELETE | `/api/admin/themes` | Thema's beheren |
| GET/POST/DELETE | `/api/admin/reports` | Rapporten beheren |
| POST | `/api/ai/advice` | AI-advies genereren (proxied) |
