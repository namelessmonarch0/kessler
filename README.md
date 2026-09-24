# Kessler

**Every tracked object in Earth orbit, 1957 to now.** A live 3D globe of about 30,000 objects in orbit right now, placed at their real positions, plus charts of how the sky got crowded, built from the full public catalog and refreshed several times a day.

Live at **[kessler.kudayyurter.dev](https://kessler.kudayyurter.dev)**.

Named after Donald Kessler, the NASA scientist who in 1978 described how collisions in a crowded orbit could cascade into more debris than falls back to Earth.

## From a MATLAB app to a website

Kessler started as *Space Debris and Objects in LEO*, a MATLAB App Designer project that won 1st place (team: Brian Alino, Meena Al Hasani, Gregory Maddox, Vedant Patel, Jessica Semaan, Kuday Yurter). That app covered China, Russia and the US from 1997 to 2022. It lives on in [`matlab/`](matlab/) with its full history.

## What's in the repo

| Folder | What it is |
|---|---|
| [`web/`](web/) | Next.js + React Three Fiber site: the globe (SGP4 in a Web Worker, real-sun day/night), animated charts, search |
| [`api/`](api/) | FastAPI + Postgres (Neon) data API and the ingest jobs that pull the catalog from CelesTrak and Space-Track |
| [`infra/`](infra/) | AWS CDK (Python): Lambda API and scheduled jobs, S3, schedules, alarms, budget |
| [`matlab/`](matlab/) | The original prize-winning MATLAB app |
| [`docs/`](docs/) | Design spec, implementation plans, and the go-live runbook (`docs/deploy.md`) |

Pushes to `main` deploy the API and jobs to AWS (GitHub Actions, OIDC) and the site to Vercel.

## Running locally

See [`api/README.md`](api/README.md) and [`web/README.md`](web/README.md).

Data: USSPACECOM via Space-Track.org; CelesTrak.
