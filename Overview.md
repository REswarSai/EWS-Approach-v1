Overview

  This is a two-part system — a Flask backend that runs the DLT-NN (Direct Linear Transformation + Neural Network) intrusion detection pipeline, and a React/Vite frontend that provides the
  user interface. The system detects DDoS attacks by training a neural network on benign traffic, generating a baseline, and then comparing test/live traffic against that baseline using
  residuals and adaptive thresholds.

  ---
  Flow 1: Dataset-Based Analysis (Full Pipeline with 3 Files)

  Step 1: User Interface — Upload Page (/upload)

  The user navigates to the Upload page (/upload), which is reached via /mode → "With Dataset" (though /upload is actually linked from ModeSelect.jsx indirectly — let me re-check...
  actually, looking at App.jsx, /upload is a direct route). The Upload.jsx component presents three file inputs:

  - Train: BENIGN-only traffic CSV
  - Test1: Mixed traffic CSV (e.g., BENIGN + attack)
  - Test2: Another mixed/attack traffic CSV

  The user selects all three files and clicks "Upload & Analyze".

  Step 2: Frontend Uploads Files to Backend

  // Upload.jsx, line 27
  await axios.post("http://localhost:5000/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });

  The formData contains three File objects appended with keys "train", "test1", "test2".

  Step 3: Backend /upload Route Saves Files

  In backend/app.py:

  @app.route("/upload", methods=["POST"])
  def upload():
      train = request.files.get("train")
      test1 = request.files.get("test1")
      test2 = request.files.get("test2")
      train_path = os.path.join(UPLOAD_FOLDER, "train.csv")
      test1_path = os.path.join(UPLOAD_FOLDER, "test1.csv")
      test2_path = os.path.join(UPLOAD_FOLDER, "test2.csv")
      train.save(train_path)  # Saves to backend/uploads/
      test1.save(test1_path)
      test2.save(test2_path)

  Files are saved as backend/uploads/train.csv, test1.csv, test2.csv.

  Step 4: Frontend Triggers Processing

  // Upload.jsx, line 32
  const processResponse = await axios.post("http://localhost:5000/process");

  Step 5: Backend /process Route Runs Full Pipeline

  @app.route("/process", methods=["POST"])
  def process():
      train_path = os.path.join(UPLOAD_FOLDER, "train.csv")
      test1_path = os.path.join(UPLOAD_FOLDER, "test1.csv")
      test2_path = os.path.join(UPLOAD_FOLDER, "test2.csv")
      results = run_full_pipeline(train_path, test1_path, test2_path, RESULTS_FOLDER, MODEL_FOLDER)
      _save_results(results)
      return jsonify({"message": "DLT-NN Processing Complete", "results": results})

  Step 6: The DLT-NN Pipeline (dlt_pipeline.py)

  run_full_pipeline() orchestrates three sub-steps:

  Step 6a: Training (run_train_only)

  1. Clean columns: Column names are stripped of spaces ("Flow Duration" → "FlowDuration").
  2. Preprocess: inf/-inf replaced with NaN, rows with NaN in any of the 27 feature columns are dropped.
  3. Aggregate by second: The data is resampled to 1-second bins. For each second, the 27 features are summed. An attack ratio is computed (non-BENIGN flows / total flows). If the ratio ≥
  0.07, the second is labeled "DDoS"; otherwise "BENIGN". Empty bins (all-zero features) are removed. A sequential Timestamp_sec column (1, 2, 3, …) is added.
  4. Filter to BENIGN only: Training uses only benign traffic to learn the normal baseline.
  5. Normalize: Each feature is normalized as (x - mean) / std per feature column. New columns FlowDuration_norm, etc. are created.
  6. Neural Network Training:
    - DatasetGeneratorNN (architecture: Linear(1,30)→Tanh × 4 → Linear(30,30)→Tanh → Linear(30,27)→Sigmoid)
    - Input X_train = sequential indices [1, 2, 3, …] reshaped to (-1, 1)
    - Target Y_train = 27 normalized features per timestamp
    - Loss function: MSE(y_true, y_pred) + 0.1 * DLT_loss
    - DLT loss = mean((x_ref - dlt_pred)^2) where x_ref = DLT of true values, dlt_pred = DLT of predictions
    - Optimizer: Adam, lr=0.01, 50 epochs
  7. Residual Computation:
    - Generate predictions gen_train = model(X_train)
    - scores = sqrt(sum((Y_train_norm - gen_train)^2, axis=1)) — Euclidean distance per timestamp
    - df_train["Score"] = scores
  8. Threshold Computation:
    - mu = scores.mean(), std = scores.std()
    - LOW_THR = mu + 1*std
    - MED_THR = mu + 2*std
    - HIGH_THR = mu + 3*std
  9. Model Persistence: The trained model and thresholds are saved to backend/models/:
    - model.pkl (pickled DatasetGeneratorNN)
    - thresholds.pkl (dict with thresholds, LOW_THR, MED_THR, HIGH_THR)
  10. Return train results: Traffic data (per-second feature values with labels), max_seconds, thresholds, residual_stats (mean, std, max).

  Step 6b & 6c: Testing (run_test_only for Test1 and Test2)

  For each test dataset (test1, test2):

  1. Load model & thresholds from backend/models/model.pkl and thresholds.pkl.
  2. Preprocess & aggregate: Same clean → preprocess → aggregate → normalize steps, but without filtering to BENIGN-only (test data contains attack traffic).
  3. Generate baseline: gen_test = model(X_test) using the sequential indices.
  4. Compute residuals: scores = sqrt(sum((Y_test_norm - gen_test)^2, axis=1))
  5. Assign warnings:
    - Score ≤ LOW_THR → "BENIGN"
    - LOW_THR < Score ≤ MED_THR → "LOW"
    - MED_THR < Score ≤ HIGH_THR → "MED"
    - Score > HIGH_THR → "HIGH"
  6. Confusion matrices & metrics (for each level LOW/MED/HIGH as "ATTACK"):
    - Filters data to Timestamp_sec ≤ flow_peak_time (peak = second with max FlowPackets/s)
    - Binary classification: BENIGN (label=0) vs not BENIGN (label=1)
    - For each warning level, y_pred=1 if Warning==level, else 0
    - Computes: accuracy, precision_attack, recall_attack, f1_attack, balanced_accuracy
    - Handles edge cases (empty subsets → all-zero matrices and metrics)
  7. Overall detection metrics:
    - y_true = (Label != "BENIGN") — binary attack indicator
    - y_pred_high = (Warning == "HIGH") — HIGH alerts as attack predictions
    - TP, FN, FP, TN computed
    - detection_rate = TP / (TP + FN)
    - false_positive_rate = FP / (FP + TN)
  8. Warning statistics: Counts of BENIGN/LOW/MED/HIGH per second.
  9. Alert timing: First LOW/MED/HIGH warning seconds, peak second and value.
  10. Traffic data: Per-second data with FlowPackets/s, FlowBytes/s, FlowDuration, Label, Warning, Score.

  Step 7: Backend Saves Results & Returns to Frontend

  def _save_results(results):
      path = os.path.join(RESULTS_FOLDER, "results.json")
      safe = _nan_to_none(results)  # Convert NaN → None for JSON
      with open(path, "w") as f:
          json.dump(safe, f, indent=2)

  The results are saved to backend/results/results.json and also returned in the HTTP response. The structure is:

  {
    "train": { "traffic_data": [...], "max_seconds": N, "thresholds": {...}, "residual_stats": {...} },
    "test1": { "traffic_data": [...], "max_seconds": N, "detection_rate": 0.x, "confusion_matrices": {...}, ... },
    "test2": { ... same structure as test1 ... }
  }

  Step 8: Frontend Displays Results

  The results are returned in the HTTP response. Upload.jsx calls setResults(resultData) and navigates to /results. The Results page uses the data immediately (no fetch needed since it's
  passed via state).

  ---
  Flow 2: Dataset-Based Analysis (Single Test File)

  Step 1-3: User uploads a single CSV

  The user goes to /mode → "With Dataset" → /dataset (DatasetUpload.jsx). This uses the pre-trained model approach — the model and thresholds must already exist in backend/models/.

  Step 4: Frontend calls /upload-test and /process-test

  // DatasetUpload.jsx, line 26
  await axios.post("http://localhost:5000/upload-test", formData, { ... });
  // DatasetUpload.jsx, line 30
  const processResponse = await axios.post("http://localhost:5000/process-test");

  Step 5: Backend processes single test

  - /upload-test saves the file as backend/uploads/test.csv
  - /process-test calls run_test_only(test_path, RESULTS_FOLDER, MODEL_FOLDER) which loads the pre-trained model and thresholds, runs the test pipeline, and saves results as {"train":
  null, "test1": test_result, "test2": null}

  Step 6: Frontend navigates to Results

  Same as the full pipeline flow, but only test1 has data.

  ---
  Flow 3: Live Capture Analysis

  Step 1: User navigates to /live

  The LiveCapture.jsx page loads and on mount:
  axios.get("http://localhost:5000/live/preview")
  This calls get_capture_preview_from_file() which reads backend/results/live_capture.csv if it exists (from a previous capture), displaying a preview of captured data.

  Step 2: User clicks "Start Capture"

  const r = await axios.post("http://localhost:5000/live/start");

  Step 3: Backend starts Scapy packet capture

  @app.route("/live/start", methods=["POST"])
  def live_start():
      from live_capture import start_capture
      out = start_capture(results_folder=RESULTS_FOLDER)
      return jsonify(out)

  start_capture() in live_capture.py:
  - Creates a daemon thread
  - The thread calls scapy.sniff() in 1-second time slices (timeout=1), with prn=_packet_handler
  - _packet_handler aggregates packets by flow key (src_ip, dst_ip, proto, src_port, dst_port), tracking timestamps and sizes per flow

  Step 4: Live polling

  While capturing, the frontend polls /live/status every second:
  pollRef.current = setInterval(pollStatus, 1000);

  The backend returns:
  {
    "capturing": True/False,
    "seconds": elapsed_seconds,
    "last_error": None,
    "preview": { "total_packets": N, "total_bytes": N, "seconds_with_data": N, "sample_rows": [...] }
  }

  The elapsed seconds and live preview (sample flows) are displayed in the UI.

  Step 5: User stops capture

  The user can click Stop (just saves) or Stop & Analyze (stops + processes).

  Step 6: Stop and save to CSV

  @app.route("/live/stop", methods=["POST"])
  def live_stop():
      from live_capture import stop_capture_and_save
      out = stop_capture_and_save(results_folder=RESULTS_FOLDER)
      return jsonify(out)

  stop_capture_and_save():
  - Sets _stop_event to halt the capture thread
  - Waits for the thread to finish (timeout=3s)
  - For each captured flow, computes:
    - Flow Duration: time difference between first and last packet
    - Inter-Arrival Times (IAT): differences between consecutive packet timestamps
    - Active/Idle times: IATs split at 1-second threshold
    - Packet/byte rates: packets/s and bytes/s
    - Flow features: 27 features matching the CSV format (FlowDuration, FlowPackets/s, FlowBytes/s, IAT stats, Active/Idle stats, Fwd/Bwd splits)
  - Saves to backend/results/live_capture.csv
  - Important: The CSV column names use spaces (e.g., "Flow Packets/s", "Flow Duration") which are different from the normalized feature names expected by the pipeline. The pipeline's
  clean_columns() function handles this by stripping spaces.

  Step 7: Process captured CSV

  After saving the CSV, the user clicks Analyze (or the auto analyze in "Stop & Analyze"):

  @app.route("/live/process", methods=["POST"])
  def live_process():
      test_result = run_test_only(live_path, RESULTS_FOLDER, MODEL_FOLDER)
      results = {"train": None, "test1": test_result, "test2": null}
      _save_results(results)
      return jsonify({"message": "Live capture analysis complete", "results": results})

  This reuses the exact same run_test_only() function — loads the pre-trained model, generates a baseline, computes residuals, assigns warnings, and produces confusion matrices.

  Step 8: Results displayed

  The frontend navigates to /results with the live capture results. The Results page handles this shape (single test, no train data) by normalizing it to { train: null, test1: results,
  test2: null }.

  ---
  Results Visualization

  Results.jsx Key Logic

  1. Results normalization: The page handles two shapes:
    - Full pipeline: { train: {...}, test1: {...}, test2: {...} }
    - Single test/live: { train: null, test1: {traffic_data, detection_rate, ...}, test2: null }
  2. Dataset tabs: Shows "Train" tab only if train data exists, "Test" for test1, "Test2" for test2.
  3. Content tabs (different per dataset type):
    - Train: "Thresholds" (L1 thresholds, residual stats) and "Graphs" (FlowPackets/s, FlowBytes/s line charts)
    - Test: "Overview" (detection rate, FPR, warning counts, first-alert times) and "Graphs" (BENIGN vs ATTACK scatter/line charts, LOW/MED/HIGH alert charts, combined alerts)
  4. Graph playback animation:
    - graphSecond state controls how many seconds of data to show (0 to max_seconds)
    - Play button: sets graphPlaying=true, increments graphSecond every 40ms
    - Show full button: sets graphSecond to max_seconds
    - When an alert second is reached during playback, an alert sound plays
  5. Confusion matrices: 2×2 grids with a Blues-style color gradient (white → dark blue). Each cell shows counts for BENIGN/PREDICTED_BENIGN, BENIGN/PREDICTED_ATTACK,
  ATTACK/PREDICTED_BENIGN, ATTACK/PREDICTED_ATTACK.

  ---
  Key Implementation Details

  Model Architecture

  - Input: Sequential time index (1, 2, 3, …) — X = torch.arange(1, N+1).reshape(-1, 1)
  - Output: 27 normalized feature values per timestamp
  - Training: MSE loss + DLT regularization loss (λ=0.1), 50 epochs
  - DLT (Direct Linear Transformation): dlt_torch(x, s=0.5) = Σ x_i · exp(-0.5·i) — a weighted sum with exponential decay, used as a regularization term to encourage the generated sequence
  to match the DLT of the real sequence

  Threshold Logic

  - Based on Euclidean distance residuals from the neural network baseline
  - LOW = μ + 1σ, MED = μ + 2σ, HIGH = μ + 3σ
  - Output: 27 normalized feature values per timestamp
  - Training: MSE loss + DLT regularization loss (λ=0.1), 50 epochs
  - DLT (Direct Linear Transformation): dlt_torch(x, s=0.5) = Σ x_i · exp(-0.5·i) — a weighted sum with exponential decay, used as a regularization term to encourage the generated sequence
  to match the DLT of the real sequence

  Threshold Logic

  - Based on Euclidean distance residuals from the neural network baseline
  - LOW = μ + 1σ, MED = μ + 2σ, HIGH = μ + 3σ
  - A residual exceeding a threshold triggers a warning of that severity

  Normalization

  - Per-feature: (x - mean) / std — computed independently on train and test data
  - Column names in CSV use spaces (e.g., "Flow Packets/s"), but the pipeline normalizes them by stripping spaces ("FlowPackets/s") and adding _norm suffix for normalized columns

  Model File Discrepancy

  - The .ipynb notebooks save model_VNRVJIET.pkl / thresholds_VNRVJIET.pkl
  - The Flask app (dlt_pipeline.py) loads model.pkl / thresholds.pkl
  - To switch between notebook experimentation and the web app, these files need to be manually copied/renamed

✻ Cooked for 1m 32s