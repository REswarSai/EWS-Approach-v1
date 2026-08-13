# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A full-stack DLT-NN (Direct Linear Transformation + Neural Network) Intrusion Detection System (IDS) web application. The backend is a Python Flask API implementing the DLT-NN pipeline; the frontend is a React single-page application (SPA) built with Vite. The system ingests CSV network flow data (or live packet captures), trains a neural network to generate a benign baseline, computes per-second residuals, and assigns LOW/MED/HIGH severity warnings when traffic deviates from the baseline.

## Repository Structure

```
v1_GUI_EWS_Approach/
├── README.md              # Project documentation (high-level pipeline description)
├── backend/
│   ├── app.py             # Flask API server (port 5000)
│   ├── dlt_pipeline.py    # Core ML pipeline (train, test, thresholds, confusion matrices)
│   ├── model.py           # PyTorch DatasetGeneratorNN model definition
│   ├── live_capture.py    # Scapy-based live packet capture
│   ├── requirements.txt   # Python dependencies
│   ├── setup_backend.ps1  # PowerShell script to create venv and install deps
│   ├── models/            # Pickled trained models and threshold files
│   ├── uploads/           # Uploaded CSV files
│   ├── results/           # results.json, live_capture.csv
│   └── *.ipynb            # Jupyter notebooks (development/experimentation)
├── frontend/
│   ├── package.json       # npm scripts and dependencies
│   ├── vite.config.js     # Vite configuration
│   ├── eslint.config.js   # ESLint flat config
│   └── src/
│       ├── main.jsx       # React entry point
│       ├── App.jsx        # Router + route definitions
│       ├── components/
│       │   └── Navbar.jsx  # Top navigation bar
│       └── pages/
│           ├── Home.jsx           # Landing page with animated traffic viz
│           ├── ModeSelect.jsx     # Mode selection (dataset vs live)
│           ├── DatasetUpload.jsx  # Single CSV upload (test-only, uses pre-trained model)
│           ├── Upload.jsx         # Three-file upload (train + test1 + test2)
│           ├── LiveCapture.jsx    # Live packet capture UI
│           └── Results.jsx        # Results visualization (charts, confusion matrices, thresholds)
└── .gitignore
```

## Development Commands

### Backend

```bash
# Create virtual environment and install dependencies
cd backend
python -m venv venv
source venv/bin/activate        # Linux/Mac
# or: venv\Scripts\activate      # Windows

pip install -r requirements.txt

# Alternative: use the provided setup script (PowerShell)
powershell -File setup_backend.ps1

# Run the Flask server
python app.py
# Backend runs at http://localhost:5000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# Frontend runs at http://localhost:5173

# Linting
npm run lint

# Production build
npm run build

# Preview production build
npm run preview
```

### Running the Full Application

1. Start the backend: `cd backend && python app.py`
2. Start the frontend: `cd frontend && npm run dev`
3. Open the frontend URL (typically `http://localhost:5173`)

The frontend makes direct API calls to `http://localhost:5000` (hardcoded in components). The vite proxy in `vite.config.js` is commented out — CORS is enabled on the Flask backend via `flask-cors`.

## Architecture

### Backend Architecture

The Flask app (`backend/app.py`) defines these API routes:

- `GET /` — health check
- `POST /upload` — upload train, test1, test2 CSVs (legacy 3-file flow)
- `POST /process` — run the full DLT-NN pipeline on the three uploaded files
- `POST /upload-test` — upload a single test CSV (requires pre-trained models)
- `POST /process-test` — run test-only analysis on a single uploaded CSV
- `POST /live/start` — start live packet capture
- `POST /live/stop` — stop capture and save to CSV
- `GET /live/status` — poll capture status
- `GET /live/preview` — read last-saved capture CSV
- `POST /live/process` — run DLT-NN on the captured CSV
- `GET /results` — return the latest results (normalized as `{ train, test1, test2 }`)

Results and model artifacts are persisted to disk:
- **Uploads**: `backend/uploads/` (`train.csv`, `test1.csv`, `test2.csv`, `test.csv`)
- **Models**: `backend/models/` (`model.pkl`, `thresholds.pkl`, plus `model_VNRVJIET.pkl` / `thresholds_VNRVJIET.pkl` variants)
- **Results**: `backend/results/results.json` (the canonical results file read by `/results`)

**Important note on model files**: The Jupyter notebooks (development artifacts) save/load `model_VNRVJIET.pkl` and `thresholds_VNRVJIET.pkl`, while `dlt_pipeline.py` (used by the running Flask app) saves/loads `model.pkl` and `thresholds.pkl`. When switching between notebook experimentation and the web app, you need to copy the appropriate files (e.g. `model_VNRVJIET.pkl` → `model.pkl`).

### DLT-NN Pipeline (`dlt_pipeline.py`)

The core pipeline mirrors the Jupyter notebooks:

1. **`clean_columns`** — strip spaces from column names.
2. **`preprocess_raw`** — replace inf/-inf with NaN, drop rows with NaN in feature columns.
3. **`aggregate_data`** — resample to 1-second bins, sum features, compute attack ratio per second, assign `DDoS` if ratio ≥ 0.07 else `BENIGN`.
4. **`normalize`** — per-feature (x − mean) / std normalization.
5. **`dlt_torch`** — DLT function: Σ x_i · exp(−s·i) with s=0.5.
6. **Training** (`run_train_only`) — trains `DatasetGeneratorNN` (1→30→30→30→30→30→27, Tanh hidden layers, Sigmoid output) with MSE + 0.1·DLT loss for 50 epochs. Computes Euclidean-distance residuals, derives thresholds μ+σ/μ+2σ/μ+3σ (LOW/MED/HIGH), saves `model.pkl` and `thresholds.pkl`.
7. **Testing** (`run_test_only`) — generates baseline from the trained model, computes residuals, assigns BENIGN/LOW/MED/HIGH labels, computes confusion matrices and metrics (detection rate, FPR, accuracy, precision, recall, F1) for each warning level, and identifies first-alert times and peak traffic.
8. **`run_full_pipeline`** — orchestrates train → test1 → test2.

### Model (`model.py`)

`DatasetGeneratorNN` is a PyTorch `nn.Module` with architecture: `Linear(1,30)→Tanh` × 4 → `Linear(30,30)→Tanh` → `Linear(30, 27)→Sigmoid`. The single input dimension is the sequential time index (1, 2, 3, …); the 27 output dimensions correspond to the 27 flow features being normalized.

### Frontend Architecture

The React app uses `react-router-dom` (v6) with a flat route structure:

- **`/`** → `Home` — landing page with a simulated traffic-bar animation.
- **`/mode`** → `ModeSelect` — card-based mode picker: "With Dataset" (single CSV) or "With Live Traffic."
- **`/dataset`** → `DatasetUpload` — drag-and-drop single CSV upload → `/upload-test` + `/process-test` → `/results`.
- **`/upload`** → `Upload` — three-file upload → `/upload` + `/process` → `/results`.
- **`/live`** → `LiveCapture` — start/stop capture, live polling, analyze captured CSV.
- **`/results`** → `Results` — tabbed results viewer with recharts charts (LineChart, ComposedChart, Scatter), confusion matrix tables, and threshold display.

The `Results` page normalizes the backend response into `{ train, test1, test2 }` and handles both the full-pipeline (3-dataset) shape and the single-test/live-capture shape (where `train` is `null`). Graph playback uses a per-second interval to animate the "build up" from 0s to end.

### Key Data Flow

```
CSV Upload → /upload[-test] → /process[-test] → run_full_pipeline / run_test_only
    → results.json → /results → frontend Results.jsx renders charts/tables
```

## Development Notes

- **No automated tests** — the project has no test suite. Verification is done manually by running the pipeline.
- **No linting on the backend** — Python files are not linted or formatted in CI.
- **Frontend lint**: `npm run lint` (ESLint with `eslint-plugin-react`, `react-hooks`, `react-refresh`).
- **Frontend API calls** are hardcoded to `http://localhost:5000` — no environment variables or proxy setup (the vite proxy config is commented out).
- The `Results copy.jsx` file in `frontend/src/pages/` appears to be a stale/older copy of `Results.jsx` and is not imported in `App.jsx`.
- **Live capture** requires Scapy and Npcap (Windows) / libpcap (Linux). On Windows, run as Administrator.