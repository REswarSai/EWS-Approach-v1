"""
DLT-NN pipeline from notebook: clean, preprocess, aggregate, normalize, train, test, thresholds, confusion matrices.
Supports separate train run and test runs for Train, Test1, Test2.
"""
import pandas as pd
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
import pickle
from pathlib import Path
from model import DatasetGeneratorNN
from sklearn.metrics import (
    confusion_matrix,
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    balanced_accuracy_score,
)

FEATURES = ['FlowDuration','FlowBytes/s','FlowPackets/s',
            'FlowIATMean','FlowIATStd','FlowIATMax','FlowIATMin',
            'FwdIATTotal','FwdIATMean','FwdIATStd','FwdIATMax','FwdIATMin','FwdPackets/s',
            'BwdIATTotal','BwdIATMean','BwdIATStd','BwdIATMax','BwdIATMin','BwdPackets/s',
            'ActiveMean','ActiveStd','ActiveMax','ActiveMin',
            'IdleMean','IdleStd','IdleMax','IdleMin']
LABEL_COL = "Label"
NUM_FEATURES = len(FEATURES)


def clean_columns(df):
    """Strip and remove spaces from column names."""
    df.columns = df.columns.str.strip().str.replace(" ", "", regex=False)
    return df


def preprocess_raw(df, features):
    """Remove inf/-inf and drop rows with NaN in feature columns."""
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna(subset=features).reset_index(drop=True)
    return df


# def aggregate_train(df):
#     """Aggregate BENIGN-only flows by second, summing features."""
#     # Fix datetime parsing warning
#     df["Timestamp"] = pd.to_datetime(df["Timestamp"], errors="coerce", format="mixed")
#     df = df.dropna(subset=["Timestamp"])
#     df.set_index("Timestamp", inplace=True)

#     # Filter to only existing columns
#     use_features = [f for f in FEATURES if f in df.columns]
#     # print(f"Using {len(use_features)} features: {use_features}")

#     # BENIGN only
#     df = df[df["Label"] == "BENIGN"]

#     # Dynamic agg dict
#     agg_dict = {f: "sum" for f in use_features}
#     agg_dict["Label"] = "size"

#     aggregated_df = df.resample("1s").agg(agg_dict).reset_index()

#     # Flatten column names
#     aggregated_df.columns = ["Timestamp"] + [
#     col if col in use_features else col for col in aggregated_df.columns[1:]
#     ]

#     # Fill NaNs for each feature
#     for f in use_features:
#         if f in aggregated_df.columns:
#             aggregated_df[f] = aggregated_df[f].fillna(0.0)

#     # Sequential timestamp
#     aggregated_df["Timestamp_sec"] = range(1, len(aggregated_df) + 1)

#     # Final column order
#     aggregated_df = aggregated_df[["Timestamp_sec"] + [c for c in aggregated_df.columns if c != "Timestamp_sec"]]
#     return aggregated_df

def aggregate_data(df, threshold=0.07):
    """Aggregate test flows by second, compute attack ratio, adaptive label."""
    df["Timestamp"] = pd.to_datetime(df["Timestamp"], errors="coerce", format="mixed")
    df = df.dropna(subset=["Timestamp"])
    df.set_index("Timestamp", inplace=True)

    # Filter to only existing columns
    use_features = [f for f in FEATURES if f in df.columns]
    # print(f"Using {len(use_features)} features: {use_features}")

    # Dynamic agg dict
    agg_dict = {f: "sum" for f in use_features}
    agg_dict['Label'] = ["size", lambda x: (x != "BENIGN").sum()]

    aggregated_df = df.resample("1s").agg(agg_dict).reset_index()

    # Flatten column names
    aggregated_df.columns = ["Timestamp"] + [
    col[0] if col[0] in use_features else f"{col[0]}_{col[1]}"
    for col in aggregated_df.columns[1:]
    ]

    # Fill NaNs
    for f in use_features:
        if f in aggregated_df.columns:
            aggregated_df[f] = aggregated_df[f].fillna(0.0)

    # Identify label columns
    label_size_col = next((c for c in aggregated_df.columns if "Label_size" in c), None)
    label_attack_col = next((c for c in aggregated_df.columns if "Label_" in c and c != label_size_col), None)

    aggregated_df["label_count"] = aggregated_df[label_size_col].fillna(0)
    aggregated_df["label_A_count"] = aggregated_df[label_attack_col].fillna(0)

    # Attack ratio
    aggregated_df["attack_ratio"] = np.where(
        aggregated_df["label_count"] > 0,
        aggregated_df["label_A_count"] / aggregated_df["label_count"],
        0
    )

    # Final label
    aggregated_df["Label"] = np.where(
        aggregated_df["attack_ratio"] >= threshold, "DDoS", "BENIGN"
    )

    # Filter empty bins
    zero_mask = pd.Series(True, index=aggregated_df.index)
    for f in use_features:
        if f in aggregated_df.columns:
            zero_mask &= (aggregated_df[f] == 0.0)
    aggregated_df = aggregated_df[~zero_mask]

    # Drop temp cols
    drop_cols = ["label_count", "label_A_count", "attack_ratio", label_size_col, label_attack_col]
    drop_cols = [c for c in drop_cols if c in aggregated_df.columns]
    aggregated_df.drop(columns=drop_cols, inplace=True)

    # Sequential timestamp
    aggregated_df["Timestamp_sec"] = range(1, len(aggregated_df) + 1)
    aggregated_df = aggregated_df[["Timestamp_sec"] + [c for c in aggregated_df.columns if c != "Timestamp_sec"]]

    return aggregated_df

def normalize(df, features):
    """Normalize features: (x - mean) / std. Matches notebook exactly."""
    for f in features:
        df[f + "_norm"] = (df[f] - df[f].mean()) / df[f].std()
    return df

def dlt_torch(x, s=0.5):
    """DLT function: matches notebook exactly."""
    n = torch.arange(len(x), dtype=torch.float32)
    return torch.sum(x * torch.exp(-s * n))


# class DatasetGeneratorNN(nn.Module):
#     def __init__(self, output_dim):
#         super().__init__()
#         layers = [nn.Linear(1, 30), nn.Tanh()]
#         for _ in range(4):
#             layers += [nn.Linear(30, 30), nn.Tanh()]
#         layers += [nn.Linear(30, output_dim), nn.Sigmoid()]
#         self.net = nn.Sequential(*layers)

#     def forward(self, x):
#         return self.net(x)


def run_train_only(train_df, results_folder, model_folder):
    """Run train pipeline only. Saves model and thresholds. Returns train results (no confusion matrix)."""
    results_folder = Path(results_folder)
    results_folder.mkdir(parents=True, exist_ok=True)
    
    model_folder = Path(model_folder)
    model_folder.mkdir(parents=True, exist_ok=True)

    train_df = clean_columns(train_df)
    if not all(f in train_df.columns for f in FEATURES):
        raise ValueError(f"Train CSV must contain columns: {FEATURES}")

    train_df = preprocess_raw(train_df, FEATURES)
    df_train = aggregate_data(train_df)
    # BENIGN only
    df_train = df_train[df_train[LABEL_COL] == "BENIGN"]
    df_train = normalize(df_train, FEATURES)

    X_train = torch.arange(1, len(df_train) + 1, dtype=torch.float32).reshape(-1, 1)
    Y_train = torch.tensor(df_train[[f + "_norm" for f in FEATURES]].values.astype(np.float32))
    x_ref = torch.stack([dlt_torch(Y_train[:, i]) for i in range(NUM_FEATURES)])

    model = DatasetGeneratorNN(NUM_FEATURES)
    optimizer = optim.Adam(model.parameters(), lr=0.01)
    mse = nn.MSELoss()
    lambda_dlt = 0.1

    def loss_fn(y_true, y_pred):
        mse_loss = mse(y_true, y_pred)
        dlt_pred = torch.stack([dlt_torch(y_pred[:, i]) for i in range(NUM_FEATURES)])
        dlt_loss = torch.mean((x_ref - dlt_pred) ** 2)
        return mse_loss + lambda_dlt * dlt_loss

    for _ in range(50):
        optimizer.zero_grad()
        y_hat = model(X_train)
        loss_fn(Y_train, y_hat).backward()
        optimizer.step()

    with torch.no_grad():
        gen_train = model(X_train).numpy()
    
    # Compute scores per sample using Euclidean Distance Formula
    scores = np.sqrt(np.sum((df_train[[f + "_norm" for f in FEATURES]].values - gen_train) ** 2, axis=1))
    
    # Store scores in DataFrame for inspection
    df_train["Score"] = scores
    
    # Thresholds based on mean + k*std
    mu = scores.mean()
    std = scores.std()

    LOW_THR = mu + 1 * std
    MED_THR = mu + 2 * std
    HIGH_THR = mu + 3 * std
    
    ews_thresholds = {"LOW": float(LOW_THR), "MED": float(MED_THR), "HIGH": float(HIGH_THR)}
    
    # Residual stats (global, not per-feature)
    residual_stats = {
        "mean": float(mu),
        "std": float(std),
        "max": float(scores.max())
    }

    # Save for test runs
    # with open(model_folder / "model_CICDDoS2019.pkl", "wb") as f:
    #     pickle.dump(model, f)
    # with open(model_folder / "thresholds_CICDDoS2019.pkl", "wb") as f:
    #     pickle.dump({
    #         "thresholds": ews_thresholds,
    #         "LOW_THR": LOW_THR,
    #         "MED_THR": MED_THR,
    #         "HIGH_THR": HIGH_THR,
    #     }, f)

    with open(model_folder / "model_VNRVJIET.pkl", "wb") as f:
        pickle.dump(model, f)
    with open(model_folder / "thresholds_VNRVJIET.pkl", "wb") as f:
        pickle.dump({
            "thresholds": ews_thresholds,
            "LOW_THR": LOW_THR,
            "MED_THR": MED_THR,
            "HIGH_THR": HIGH_THR,
        }, f)

    # with open(model_folder / "model.pkl", "wb") as f:
    #     pickle.dump(model, f)
    # with open(model_folder / "thresholds.pkl", "wb") as f:
    #     pickle.dump({
    #         "thresholds": ews_thresholds,
    #         "LOW_THR": LOW_THR,
    #         "MED_THR": MED_THR,
    #         "HIGH_THR": HIGH_THR,
    #     }, f)

    max_seconds = int(df_train["Timestamp_sec"].max())
    traffic_data = []
    
    for _, row in df_train.iterrows():
        row_dict = {
            "second": int(row["Timestamp_sec"]),
            "Label": str(row["Label"])
        }
        # Add all features dynamically
        for f in FEATURES:
            safe_key = f.replace(" ", "_").replace("/", "_")  # normalize key names
            row_dict[safe_key] = float(row[f]) if f in row else 0.0
        traffic_data.append(row_dict)

    return {
        "traffic_data": traffic_data,
        "max_seconds": max_seconds,
        "thresholds": ews_thresholds,
        "residual_stats": residual_stats,
    }

def run_test_only(test_df, results_folder, model_folder):
    """Load model and thresholds, run test pipeline. Returns test results with confusion matrices and Kurtosis."""
    
    if isinstance(test_df, (str, Path)):
        test_df = pd.read_csv(test_df)
    else:
        test_df = test_df
    
    results_folder = Path(results_folder)
    model_folder = Path(model_folder)
    
    # with open(model_folder / "model_CICDDoS2019.pkl", "rb") as f:
    #     model = pickle.load(f)
    # with open(model_folder / "thresholds_CICDDoS2019.pkl", "rb") as f:
    #     th = pickle.load(f)
        
    with open(model_folder / "model_VNRVJIET.pkl", "rb") as f:
        model = pickle.load(f)
    with open(model_folder / "thresholds_VNRVJIET.pkl", "rb") as f:
        th = pickle.load(f)
    
    # with open(model_folder / "model.pkl", "rb") as f:
    #     model = pickle.load(f)
    # with open(model_folder / "thresholds.pkl", "rb") as f:
    #     th = pickle.load(f)
        
    LOW_THR = th["LOW_THR"]
    MED_THR = th["MED_THR"]
    HIGH_THR = th["HIGH_THR"]

    if test_df.empty:
        raise ValueError("Test CSV file is empty.")
    test_df = clean_columns(test_df)
    required = FEATURES + ["Label", "Timestamp"]
    missing = [c for c in required if c not in test_df.columns]
    if missing:
        raise ValueError(
            f"Test CSV must contain columns: Timestamp, FlowPackets/s, FlowBytes/s, FlowDuration Label. Missing: {missing}. "
            "Column names are normalized (spaces stripped)."
        )
    
    test_df = preprocess_raw(test_df, FEATURES)
    if test_df.empty:
        raise ValueError("No valid rows after preprocessing (check for NaN/inf in FlowPackets/s, FlowBytes/s and FlowDuration).")
    df_test = aggregate_data(test_df)
    df_test = normalize(df_test, FEATURES)

    X_test = torch.arange(1, len(df_test) + 1, dtype=torch.float32).reshape(-1, 1)
    with torch.no_grad():
        gen_test = model(X_test).numpy()
    
    scores = np.sqrt(np.sum((df_test[[f + "_norm" for f in FEATURES]].values - gen_test) ** 2, axis=1))

    
    # Store scores in DataFrame for inspection
    df_test["Score"] = scores

    def assign_warning(row):
        R = row["Score"]
        if R <= LOW_THR:
            return "BENIGN"
        if R <= MED_THR:
            return "LOW"
        if R <= HIGH_THR:
            return "MED"
        return "HIGH"

    df_test["Warning"] = df_test.apply(assign_warning, axis=1)

    # Confusion matrices and metrics (notebook: filter by flow_peak_time and BENIGN|Warning==level)
    flow_peak_time = df_test.loc[df_test["FlowPackets/s"].idxmax(), "Timestamp_sec"]
    df_r = df_test[df_test["Timestamp_sec"] <= flow_peak_time].copy()
    confusion_matrices = {}
    confusion_metrics = {}
    for level in ["LOW", "MED", "HIGH"]:
        df_sub = df_r[(df_r["Label"] == "BENIGN") | (df_r["Warning"] == level)]
        if df_sub.empty:
            # Gracefully handle cases where there are no samples for this level
            # (e.g., all traffic is BENIGN and model never produces this warning).
            cm = np.array([[0, 0], [0, 0]], dtype=int)
            confusion_matrices[level] = cm.tolist()
            confusion_metrics[level] = {
                "accuracy": 0.0,
                "precision_attack": 0.0,
                "recall_attack": 0.0,
                "f1_attack": 0.0,
                "balanced_accuracy": 0.0,
            }
            continue

        y_true = df_sub["Label"].apply(lambda x: 0 if x == "BENIGN" else 1).values
        y_pred = df_sub["Warning"].apply(lambda x: 1 if x == level else 0).values
        cm = confusion_matrix(y_true, y_pred, labels=[0, 1])
        confusion_matrices[level] = cm.tolist()
        confusion_metrics[level] = {
            "accuracy": float(accuracy_score(y_true, y_pred)),
            "precision_attack": float(precision_score(y_true, y_pred, pos_label=1, zero_division=0)),
            "recall_attack": float(recall_score(y_true, y_pred, pos_label=1, zero_division=0)),
            "f1_attack": float(f1_score(y_true, y_pred, pos_label=1, zero_division=0)),
            "balanced_accuracy": float(balanced_accuracy_score(y_true, y_pred)),
        }

    y_true = (df_test["Label"] != "BENIGN").astype(int).values
    y_pred_high = (df_test["Warning"] == "HIGH").astype(int).values
    tp = ((y_true == 1) & (y_pred_high == 1)).sum()
    fn = ((y_true == 1) & (y_pred_high == 0)).sum()
    fp = ((y_true == 0) & (y_pred_high == 1)).sum()
    tn = ((y_true == 0) & (y_pred_high == 0)).sum()
    detection_rate = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    false_positive_rate = fp / (fp + tn) if (fp + tn) > 0 else 0.0
    warnings_count = {k: int(v) for k, v in df_test["Warning"].value_counts().to_dict().items()}

    # First warning times and peak (for frontend graphs)
    first_low = float(df_test.loc[df_test["Warning"] == "LOW", "Timestamp_sec"].min()) if (df_test["Warning"] == "LOW").any() else None
    first_med = float(df_test.loc[df_test["Warning"] == "MED", "Timestamp_sec"].min()) if (df_test["Warning"] == "MED").any() else None
    first_high = float(df_test.loc[df_test["Warning"] == "HIGH", "Timestamp_sec"].min()) if (df_test["Warning"] == "HIGH").any() else None
    peak_idx = df_test["FlowPackets/s"].idxmax()
    peak_sec = int(df_test.loc[peak_idx, "Timestamp_sec"])
    peak_val = float(df_test.loc[peak_idx, "FlowPackets/s"])

    max_seconds = int(df_test["Timestamp_sec"].max())
    traffic_data = []
    for _, row in df_test.iterrows():
        traffic_data.append({
            "second": int(row["Timestamp_sec"]),
            "FlowPackets_s": float(row["FlowPackets/s"]),
            "FlowBytes_s": float(row["FlowBytes/s"]),
            "FlowDuration": float(row["FlowDuration"]),
            "Label": str(row["Label"]),
            "Warning": str(row["Warning"]),
            "score": float(row["Score"])
        })

    return {
        "detection_rate": detection_rate,
        "false_positive_rate": false_positive_rate,
        "warnings": warnings_count,
        "traffic_data": traffic_data,
        "max_seconds": max_seconds,
        "confusion_matrices": confusion_matrices,
        "confusion_metrics": confusion_metrics,
        "first_low": first_low,
        "first_med": first_med,
        "first_high": first_high,
        "peak_sec": peak_sec,
        "peak_val": peak_val,
    }

def run_full_pipeline(train_path, test1_path, test2_path, results_folder, model_folder):
    """Run train once, then test for test1 and test2. Returns { train, test1, test2 }."""
    train_results = run_train_only(train_path, results_folder, model_folder)
    test1_results = run_test_only(test1_path, results_folder, model_folder)
    test2_results = run_test_only(test2_path, results_folder, model_folder)
    return {
        "train": train_results,
        "test1": test1_results,
        "test2": test2_results,
    }