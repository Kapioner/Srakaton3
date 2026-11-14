# Plan implementacji: Harmonized Burning Activity Calendar

Termin: **niedziela 15.11.2026, 23:59** (zgłoszenie po angielsku i demo). Dane deweloperskie: `sample_data/` (Grecja, MODIS 2000–2025, VIIRS S-NPP 2012–2025, VIIRS NOAA-20 2018–2025, około 15 MB).

Kontekst, stack i kryteria oceny: [CLAUDE.md](../CLAUDE.md).

---

## 1. Cel MVP (definicja „gotowe”)

Użytkownik otwiera aplikację, zaznacza region na mapie Grecji, wybiera zakres dat i w kilka sekund widzi:

1. **Kalendarz aktywności** rok × miesiąc (2001–2025) ze zharmonizowanymi liczbami. Kolory w dwóch trybach: liczba wykryć oraz anomalia względem średniej wieloletniej.
2. **Tekst z wnioskiem**, na przykład: „Sierpień 2023: 4,1× powyżej średniej 2001–2022, najwyższy miesiąc w historii regionu”.
3. **Mapę** z zagregowaną aktywnością w wybranym okresie.
4. **Wykresy:** suma roczna, sezonowość (wybrany rok na tle średniej i rozrzutu) oraz wykres metodologiczny „surowe dane a dane zharmonizowane”.
5. **Pobieranie:** CSV z hotspotami z wyszukiwania i PNG każdego wykresu.

Wszystko z zadania jest w tej liście. Elementy dodatkowe są dopiero w sekcji 8.

---

## 2. Architektura

```
sample_data/<sensor>/*.csv
        │
        ▼
 etl/  (TypeScript + DuckDB)            ── uruchamiany ręcznie: npm run etl
   1. load + unify schema
   2. filter (type = 0)
   3. grid + daily cells
   4. calibration (overlap MODIS ↔ VIIRS)
        │
        ▼
 data/processed/            (w .gitignore; odtwarzalne z ETL)
   hotspots.parquet          surowe, ujednolicone punkty (do CSV i mapy przy dużym zoomie)
   daily_cells.parquet       komórka × dzień × sensor (podstawa wszystkich agregatów)
   calibration.json          współczynniki harmonizacji
        │
        ▼
 server/  (Fastify + @duckdb/node-api, tylko odczyt)
   /api/meta  /api/calendar  /api/summary  /api/grid  /api/points  /api/export.csv
        │  JSON (małe agregaty) / strumień CSV
        ▼
 web/  (React + Vite, MapLibre + terra-draw, ECharts)
```

Zakres danych ustawiamy w konfiguracji (`DATA_DIR`, `DATA_COUNTRIES`, `DATA_YEARS`), żeby ten sam kod działał dla całego świata.

---

## 3. Harmonizacja: metoda v1

Pomiary na danych przykładowych (2023–2025, `type = 0`, kratki około 1 km na dzień):
- VIIRS ma 3,1–3,8 raza więcej **punktów** niż MODIS;
- po zliczeniu **kratek** różnica spada do 1,8–2,5 raza.

Sama siatka więc nie wystarcza i potrzebna jest kalibracja.

**Kroki:**

1. **Wspólny schemat** wszystkich sensorów:

   | Kolumna | Opis |
   |---|---|
   | `lat`, `lon` | współrzędne |
   | `acq_date` | data |
   | `acq_time` | godzina UTC, HHMM |
   | `sensor` | `MODIS` lub `VIIRS` |
   | `satellite` | `Terra`, `Aqua`, `N` lub `N20` |
   | `confidence_raw` | oryginalna wartość |
   | `confidence` | `low`, `nominal` lub `high` (MODIS: poniżej 30, 30–80, powyżej 80) |
   | `brightness` | `brightness` z MODIS albo `bright_ti4` z VIIRS |
   | `frp` | moc radiacyjna pożaru |
   | `daynight` | dzień lub noc |
   | `type` | typ źródła |
   | `version` | wersja produktu |
   | `country` | kraj |
   | `source_file` | plik źródłowy |

2. **Filtr:** zostawiamy tylko `type = 0`, czyli pożary roślinności. Wartości 2 (przemysł) i 3 (morze) odrzucamy.
3. **Siatka:** kratka 0,01° (około 1 km, czyli rozmiar piksela MODIS); `cell = (floor(lat/0.01), floor(lon/0.01))`. Dla każdej pary (komórka, dzień) zapisujemy flagi sensorów (`has_modis`, `has_snpp`, `has_n20`), liczbę wykryć i maksymalne FRP.
4. **Ery konstelacji satelitów:**

   | Era | Lata | Dostępne sensory |
   |---|---|---|
   | E1 | 2001–2011 | MODIS |
   | E2 | 2012–2017 | MODIS + S-NPP |
   | E3 | 2018–2025 | MODIS + S-NPP + NOAA-20 |

5. **Jednostka zharmonizowana: aktywne kratki w ekwiwalencie MODIS.** MODIS działa przez cały okres, więc jest naturalnym punktem odniesienia. W każdej erze liczymy unię kratek ze wszystkich dostępnych sensorów, czyli wykorzystujemy cały detal VIIRS i wypełniamy luki MODIS. Następnie skalujemy wynik współczynnikiem:

   `f(era, miesiąc) = Σ kratki_MODIS / Σ kratki_unii`

   Współczynnik liczymy z lat danej ery, osobno dla każdego miesiąca kalendarzowego, bo VIIRS zyskuje najwięcej przy małych pożarach zimą i wiosną.

   `harmonized(dzień) = kratki_unii(dzień) × f(era, miesiąc)`

   W erze E1 wynik to po prostu kratki MODIS, bo f = 1.

6. **Odporność na przyszłość:** gdy MODIS zostanie wyłączony (Terra i Aqua kończą misje), współczynnik z ery E3 pozwala kontynuować serię z samych danych VIIRS. To dobry argument na pitch.
7. **Zapisujemy też liczby surowe** (punkty i kratki per sensor), żeby wykres metodologiczny mógł pokazać „przed i po”.

**Walidacja**, czyli dowód na slajd:
- surowa liczba punktów: widoczne skoki w 2012 i 2018 roku;
- dane zharmonizowane: brak skoków;
- w latach 2012–2025 porównujemy dane zharmonizowane z samym MODIS-em (korelacja miesięczna, oczekujemy r > 0,9);
- znane pożary (sierpień 2007 na Peloponezie, lipiec 2018 w Mati, sierpień 2021 na Eubei, lipiec i sierpień 2023 na Rodos i w Evros) muszą wyjść jako najwyższe anomalie.

**Ryzyko:** orbity Terra i Aqua dryfują w ostatnich latach, więc MODIS może tracić czułość po około 2022 roku. Jeśli współczynniki wyjdą niestabilne, liczymy f tylko z lat 2018–2021 albo jedną wartość na erę zamiast na miesiąc.

Metoda v2, jeśli zostanie czas: regresja per region i sezon albo kratka 375 m z wagą FRP. **Nie robimy jej w MVP.**

---

## 4. Kontrakt API

Wszystkie endpointy przyjmują `bbox=minLon,minLat,maxLon,maxLat`, `from=YYYY-MM-DD` i `to=YYYY-MM-DD`. Brak `bbox` oznacza cały zbiór danych.

| Endpoint | Zwraca |
|---|---|
| `GET /api/meta` | zakres dat, bbox danych, listę sensorów i ery, współczynniki kalibracji |
| `GET /api/calendar?granularity=month\|day&metric=harmonized\|raw_points\|raw_cells` | `[{year, month, [day], value, anomaly, rank}]` oraz `baseline` (średnia i odchylenie per miesiąc) |
| `GET /api/summary` | sumy, najlepszy miesiąc i rok, porównanie z bazą, dane do tekstu z wnioskiem |
| `GET /api/series?by=year\|month` | szereg roczny i miesięczny: zharmonizowany oraz surowy per sensor (wykres metodologiczny) |
| `GET /api/grid?res=0.05\|0.1` | GeoJSON zagregowanych kratek z liczbą wykryć (mapa) |
| `GET /api/points?limit=50000` | surowe punkty jako GeoJSON (mapa przy dużym zoomie, z limitem) |
| `GET /api/export.csv` | **strumień** ujednoliconych hotspotów z wyszukiwania |

**Najpierw ustalamy przykładowe odpowiedzi JSON** (`server/fixtures/*.json`), żeby frontend mógł pracować na mockach, zanim gotowe będzie ETL.

---

## 5. Frontend: ekran

```
┌──────────────────────────────────────────────────────────────────────┐
│ 🔥 Nazwa · [zakres dat ▾] [region: narysuj / cała Grecja] [CSV ⬇]    │
├───────────────────────────────┬──────────────────────────────────────┤
│                               │  Wniosek (duży tekst):               │
│   MAPA (MapLibre, ciemna)     │  „Sierpień 2023 = 4,1× normy…”       │
│   heatmapa / kratki            ├──────────────────────────────────────┤
│   + rysowanie prostokąta       │  KALENDARZ rok × miesiąc (ECharts)   │
│                               │  [liczba | anomalia]  [PNG ⬇]         │
├───────────────────────────────┴──────────────────────────────────────┤
│  Suma roczna (słupki)  │  Sezonowość: wybrany rok vs średnia ± zakres │
├──────────────────────────────────────────────────────────────────────┤
│  Zakładka „Metodologia”: surowe dane vs zharmonizowane, ery, wsp.    │
└──────────────────────────────────────────────────────────────────────┘
```

- **Skale kolorów:**
  - liczba wykryć: sekwencyjna (`YlOrRd` albo `inferno`), z logarytmem przy dużych różnicach;
  - anomalia: rozbieżna (niebieski–biały–czerwony), z wartościami w tooltipach, żeby nie polegać tylko na kolorze.
- **Kliknięcie komórki kalendarza** ustawia zakres dat na ten miesiąc, a mapa i wykresy się przeliczają.

---

## 6. Etapy i podział pracy

Cztery ścieżki równoległe po wspólnym kroku 0:

| # | Etap | Ścieżka | Czas | Wynik |
|---|---|---|---|---|
| 0 | Szkielet monorepo, konfiguracja, kontrakt API i fixtures | wszyscy | 1 h | `npm run dev` uruchamia server i web, mocki odpowiadają |
| 1 | ETL: schemat, filtr, siatka, `daily_cells`, Parquet | **A (dane)** | 3 h | `npm run etl` w kilka sekund dla Grecji |
| 2 | Kalibracja i walidacja (współczynniki, wykres przed i po, znane pożary) | **A** | 2–3 h | `calibration.json`, liczby i wykres na slajd |
| 3 | API: endpointy na DuckDB, streaming CSV | **B (backend)** | 3–4 h | endpointy z sekcji 4 na prawdziwych danych |
| 4 | Frontend: mapa, wybór regionu, kalendarz, wykresy, pobieranie | **C (frontend)** | 6–8 h | ekran z sekcji 5, najpierw na mockach |
| 5 | Tekst z wnioskiem, anomalie i ranking | B + C | 2 h | tekst z wnioskiem na ekranie |
| 6 | Dowód skalowania: ETL na jednym pełnym roku globalnym i pomiar czasów | A | 1–2 h | liczby na slajd (opcjonalne) |
| 7 | Pitch (3 min), demo (7 slajdów lub 30 s wideo), README, formularz po angielsku | **D (prezentacja)** | zaczynamy w sobotę, kończymy w niedzielę po południu | gotowe zgłoszenie przed 23:59 |

**Punkty kontrolne:**
- **sobota wieczór:** ETL i kalibracja gotowe, API zwraca kalendarz, front pokazuje kalendarz na prawdziwych danych;
- **niedziela przed południem:** wszystkie funkcje MVP;
- **niedziela 16:00:** zamrażamy funkcje, dalej tylko poprawki, deploy lub nagranie, slajdy i formularz.

---

## 7. Struktura repozytorium

```
etl/
  scripts/download-firms.mjs      pobieranie danych (gotowe)
  src/config.ts                   DATA_DIR, kraje, lata, rozdzielczość siatki
  src/load.ts                     CSV → wspólny schemat (DuckDB SQL)
  src/grid.ts                     daily_cells
  src/calibrate.ts                współczynniki i raport walidacji
  src/index.ts                    pipeline
server/
  src/index.ts                    Fastify, CORS, kompresja, statyczne pliki web/dist
  src/db.ts                       instancja DuckDB, widoki na Parquet
  src/queries/*.ts                calendar, summary, series, grid, points, export
  src/params.ts                   walidacja bbox i dat
  fixtures/*.json                 przykładowe odpowiedzi dla frontu
web/
  src/api.ts                      klient API (z przełącznikiem na mocki)
  src/components/Map.tsx, Calendar.tsx, YearBars.tsx, Seasonality.tsx,
                 Insight.tsx, Methodology.tsx, Controls.tsx
docs/PLAN.md
package.json                      npm workspaces: etl, server, web
```

---

## 8. Poza MVP (jeśli zostanie czas)

- Wybór regionu jako dowolny poligon albo jednostka administracyjna (rozszerzenie spatial w DuckDB).
- deck.gl: heksagony H3 i widok 3D.
- Animacja sezonu dzień po dniu.
- Raport PDF z wyszukiwania.
- Drugi kraj, na przykład Polska.

---

## 9. Ryzyka

| Ryzyko | Co robimy |
|---|---|
| `@duckdb/node-api` sprawia problemy na Windowsie | sprawdzamy w kroku 0; awaryjnie paczka `duckdb` albo ETL w Pythonie (DuckDB) |
| Kalibracja wychodzi niestabilna | uproszczenie (jeden współczynnik na erę); na slajdzie uczciwie opisujemy ograniczenia |
| Za mało czasu na front | priorytet: kalendarz, tekst z wnioskiem, CSV; mapa może pokazywać tylko bbox i kratki |
| Prezentacja na ostatnią chwilę | osoba D zaczyna szkic w sobotę i co kilka godzin zbiera zrzuty ekranu |
