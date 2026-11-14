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
 etl/  (TypeScript + DuckDB)            ── npm run etl:all
   normalize   CSV → wspólny schemat, Parquet year=/country=
   harmonize   kalibracja k (satelita × klasa FRP) + agregat dzienny
   report      raport HTML „przed i po”
        │
        ▼
 data/parquet/              (w .gitignore; odtwarzalne z ETL)
   hotspots/year=/country=/   surowe, ujednolicone wykrycia (do CSV i mapy przy dużym zoomie)
   harmonized/year=/          kratka 0,1° × dzień: h, h_modis, h_viirs, n_modis, n_viirs
   calibration/k.parquet      współczynniki k + params.json
        │
        ▼
 server/  (Fastify + @duckdb/node-api, tylko odczyt)
   /api/meta  /api/calendar  /api/summary  /api/series  /api/grid  /api/points  /api/export.csv
        │  JSON (małe agregaty) / strumień CSV
        ▼
 web/  (React + Vite, MapLibre + terra-draw, ECharts)
```

Zakres danych ustawiamy w konfiguracji (`DATA_COUNTRIES`, `DATA_YEARS`, `INPUT_DIR`, `OUTPUT_DIR` w `.env` albo flagach CLI), żeby ten sam kod działał dla całego świata.

---

## 3. Harmonizacja

Zaimplementowana w `etl/src/harmonization.ts` (z gałęzi etls). Pełny opis: CLAUDE.md, sekcja „Chosen method”. Zastąpiła pierwotną metodę v1 z tego planu (ery × miesiąc), bo lepiej zgadza się między sensorami.

- **Jednostka:** fire cell-day, czyli kratka 0,02° z co najmniej jednym wykryciem `type = 0` przez jednego satelitę w jednym dniu.
- **Klasy wielkości pożaru** według sumy FRP (< 5, 5–10, 10–20, 20–40, ≥ 40 MW), bo stosunek VIIRS/MODIS zależy od wielkości pożaru.
- **Kalibracja:** `k[satelita, klasa]` względem MODIS Aqua, liczona na okresie wspólnego działania, per kraj, ściągana do wartości globalnej.
- **Łączenie** (Poisson MLE): `h = Σ n / Σ k` po satelitach, które latały danego dnia. Dodanie lub utrata satelity zmienia szum, a nie poziom.
- **Wynik:** jednostka „Aqua-equivalent fire cell-days” w kratce 0,1° × dzień. `h_modis` i `h_viirs` to ta sama wielkość liczona tylko z jednej rodziny sensorów.

**Walidacja na Grecji** (`npm run etl:harmonize`): w latach 2012–2025 `h_modis` i `h_viirs` różnią się średnio o około 6% rocznie. Surowe liczby wykryć skaczą z 2 651 (2011) do 10 018 (2012), a `h` tego skoku nie ma. Raport z wykresami: `npm run etl:report`.

**Do sprawdzenia:** lata 2000–2002, gdy latał tylko Terra (przed Aqua). Wartość `h` dla 2001 roku (2 110 wobec 520 w 2002) wygląda na zawyżoną przez współczynnik Terra; październik 2001 wychodzi jako najwyższy miesiąc całej serii.

---|---|
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
| `GET /api/meta` | zakres dat, bbox danych, satelity, parametry harmonizacji, współczynniki k i zgodność sensorów |
| `GET /api/calendar?granularity=month\|day&metric=h\|h_modis\|h_viirs\|raw` | `[{year, month, [day], value, anomaly, rank}]` oraz `baseline` (średnia i odchylenie per miesiąc) |
| `GET /api/summary` | sumy, najlepszy miesiąc i rok, porównanie z bazą, dane do tekstu z wnioskiem |
| `GET /api/series?by=year\|month` | szereg roczny i miesięczny: `h`, `h_modis`, `h_viirs` i surowe `n_modis`, `n_viirs` (wykres metodologiczny) |
| `GET /api/grid?res=0.1\|0.25\|0.5` | GeoJSON kratek z `h`, liczbą wykryć i dni aktywnych (mapa) |
| `GET /api/points?limit=50000` | surowe punkty jako GeoJSON (mapa przy dużym zoomie, z limitem) |
| `GET /api/export.csv` | **strumień** ujednoliconych hotspotów z wyszukiwania |

Typy: `shared/api.ts`. Przykładowe odpowiedzi (`server/fixtures/*.json`) generuje z wyjścia ETL `npm run fixtures -w server`; serwer zwraca je automatycznie, gdy w `OUTPUT_DIR` nie ma danych Parquet (`DATA_SOURCE=auto`).

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
| 1 | ETL: schemat, filtr, siatka, Parquet | **A (dane)** | gotowe | `npm run etl:all` w kilka sekund dla Grecji |
| 2 | Kalibracja i walidacja (współczynniki, wykres przed i po, znane pożary) | **A** | gotowe; do sprawdzenia lata tylko z Terra | `calibration/k.parquet`, raport HTML |
| 3 | API: endpointy na DuckDB, streaming CSV | **B (backend)** | gotowe | endpointy z sekcji 4 na Parquet, z filtrami regionu i dat |
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
  scripts/download-firms.mjs          pobieranie CSV dla jednego kraju
  scripts/download-firms-world.mjs    archiwa ZIP dla całego świata
  src/config.ts                       zakres danych (kraje, lata, katalogi)
  src/sources.ts, sql.ts              wyszukiwanie plików, CSV → wspólny schemat
  src/normalize.ts                    krok 1: Parquet hotspots/
  src/harmonization.ts, harmonize.ts  krok 2: kalibracja k i harmonized/
  src/report.ts                       krok 3: raport HTML
server/
  src/index.ts                        Fastify, CORS, kompresja, statyczne pliki web/dist
  src/config.ts                       OUTPUT_DIR, API_PORT, DATA_SOURCE, limity DuckDB
  src/db.ts                           instancja DuckDB, limit pamięci i czasu, kolejka zapytań
  src/dataset.ts                      wykrywanie danych, widoki na Parquet, metadane w pamięci
  src/queries.ts                      calendar, summary, series, grid, points, export (z filtrami)
  src/params.ts                       walidacja bbox i dat
  scripts/make-fixtures.ts            fixtures z wyjścia ETL
  fixtures/*.json                     przykładowe odpowiedzi dla frontu
shared/api.ts                         kontrakt API (typy dla server i web)
web/
  src/api.ts                          klient API
  src/components/Map.tsx, Calendar.tsx, YearBars.tsx, Seasonality.tsx,
                 Insight.tsx, Methodology.tsx, Controls.tsx
docs/PLAN.md
package.json                          npm workspaces: etl, server, web
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
| Kalibracja wychodzi niestabilna | uproszczenie liczby klas FRP; na slajdzie uczciwie opisujemy ograniczenia |
| Za mało czasu na front | priorytet: kalendarz, tekst z wnioskiem, CSV; mapa może pokazywać tylko bbox i kratki |
| Prezentacja na ostatnią chwilę | osoba D zaczyna szkic w sobotę i co kilka godzin zbiera zrzuty ekranu |
