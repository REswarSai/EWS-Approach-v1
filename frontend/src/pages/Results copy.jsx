import { useState, useEffect, useCallback, useRef } from "react";
import {LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, 
  Scatter, ComposedChart, ReferenceLine } from "recharts";

const DATASET_TRAIN = "train";
const DATASET_TEST1 = "test1";
const DATASET_TEST2 = "test2";

const TAB_OVERVIEW = "overview";
const TAB_GRAPHS = "graphs";
const TAB_CONFUSION = "confusion";
const TAB_INTERPOLATION = "interpolation";
const TAB_THRESHOLDS = "thresholds";

// Blues colormap (0 = white, 1 = dark blue) for confusion matrix
function bluesColor(t) {
  const r = Math.round(247 - t * (247 - 8));
  const g = Math.round(251 - t * (251 - 69));
  const b = Math.round(255 - t * (255 - 107));
  return `rgb(${r},${g},${b})`;
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

function Results({ results, fetchResults }) {
  // Normalize so we always have { train, test1, test2 } (live capture and CSV test use test1)
  // const normalized =
  //   results && typeof results === "object"
  //     ? results.test1 !== undefined
  //       ? results
  //       : results.traffic_data || results.detection_rate !== undefined
  //         ? { train: null, test1: results, test2: null }
  //         : { train: results.train ?? null, test1: results.test1 ?? null, test2: results.test2 ?? null }
  //     : null;

  const normalized =
    results && typeof results === "object"
      ? results.test1 !== undefined
        ? results
        : results.traffic_data || results.first_low || results.first_med || results.first_high !== undefined
          ? { train: null, test1: results, test2: null }
          : { train: results.train ?? null, test1: results.test1 ?? null, test2: results.test2 ?? null }
      : null;

  const hasTrain = normalized?.train && (normalized.train.traffic_data?.length > 0 || normalized.train.thresholds);
  const [dataset, setDataset] = useState(hasTrain ? DATASET_TRAIN : DATASET_TEST1);
  const [activeTab, setActiveTab] = useState(hasTrain ? TAB_THRESHOLDS : TAB_OVERVIEW);
  useEffect(() => {
    const ht = normalized?.train && (normalized.train.traffic_data?.length > 0 || normalized.train.thresholds);
    if (normalized && !ht && normalized.test1) {
      setDataset(DATASET_TEST1);
      setActiveTab(TAB_OVERVIEW);
    }
  }, [normalized]);
  const [confusionVisible, setConfusionVisible] = useState(false);
  const [graphSecond, setGraphSecond] = useState(0);
  const [graphPlaying, setGraphPlaying] = useState(false);
  const [currentGraphIndex, setCurrentGraphIndex] = useState(0);
  const graphSpeed = 40;

  const isLegacy = normalized && !normalized.train && (normalized.test1?.traffic_data || normalized.test1?.thresholds);
  const trainData =
    normalized?.train ??
    (isLegacy && normalized?.test1?.thresholds
      ? {
          thresholds: normalized.test1.thresholds,
          per_feature_thresholds: normalized.test1.per_feature_thresholds,
          residual_stats: normalized.test1.residual_stats,
          data_after_interpolation: normalized.test1.data_after_interpolation,
          traffic_data: [],
          max_seconds: normalized.test1.max_seconds ?? 0,
        }
      : null);
  const test1Data = normalized?.test1 ?? (isLegacy ? normalized : null);
  const test2Data = normalized?.test2 ?? null;

  const isTrain = dataset === DATASET_TRAIN;
  const current = isTrain ? trainData : dataset === DATASET_TEST1 ? test1Data : test2Data;
  // const graphTitles = isTrain
  //   ? ["1. TRAIN — FlowPackets/s vs Seconds", "2. TRAIN — FlowBytes/s vs Seconds"]
  //   : [
  //       "1. TEST — FlowPackets/s vs Seconds (Label)",
  //       "2. TEST — FlowBytes/s vs Seconds (Label)",
  //       "2. FlowPackets/s — LOW Alerts",
  //       "3. FlowPackets/s — MED Alerts",
  //       "4. FlowPackets/s — HIGH Alerts",
  //       "5. FlowPackets/s — LOW / MED / HIGH Alerts",
  //       "7. Kurtosis with LOW Warnings",
  //       "8. Kurtosis with MED Warnings",
  //       "9. Kurtosis with HIGH Warnings",
  //     ];

  const graphTitles = isTrain
    ? ["1. TRAIN — FlowPackets/s vs Seconds", "2. TRAIN — FlowBytes/s vs Seconds", "3. TRAIN — FlowDuration vs Seconds"]
    : [
        "1. TEST — FlowPackets/s vs Seconds (Label)",
        "2. TEST — FlowBytes/s vs Seconds (Label)",
        "3. TEST — FlowDuration vs Seconds (Label)",
        "4. FlowPackets/s — LOW Alerts",
        "5. FlowPackets/s — MEDIUM Alerts",
        "6. FlowPackets/s — HIGH Alerts",
        "7. FlowPackets/s — LOW / MEDIUM / HIGH Alerts",
      ];
  useEffect(() => {
    if (currentGraphIndex >= graphTitles.length && graphTitles.length > 0)
      setCurrentGraphIndex(graphTitles.length - 1);
  }, [dataset, graphTitles.length, currentGraphIndex]);
  const maxSeconds = current?.max_seconds ?? 0;
  const trafficData = current?.traffic_data ?? [];
  const visibleData = trafficData.filter((d) => d.second <= graphSecond);

  const alertedSecondsRef = useRef(new Set());
  useEffect(() => {
    if (!graphPlaying || !trafficData.length) return;
    const d = trafficData.find((x) => x.second === graphSecond && ["LOW", "MED", "HIGH"].includes(x.Warning));
    if (d && !alertedSecondsRef.current.has(graphSecond)) {
      alertedSecondsRef.current.add(graphSecond);
      playAlertSound();
    }
  }, [graphPlaying, graphSecond, trafficData]);

  useEffect(() => {
    if (!graphPlaying || graphSecond >= maxSeconds) {
      if (graphSecond >= maxSeconds) setGraphPlaying(false);
      return;
    }
    const t = setInterval(() => setGraphSecond((s) => Math.min(s + 1, maxSeconds)), graphSpeed);
    return () => clearInterval(t);
  }, [graphPlaying, graphSecond, maxSeconds, graphSpeed]);

  const playGraph = useCallback(() => {
    alertedSecondsRef.current.clear();
    setGraphSecond(0);
    setGraphPlaying(true);
  }, []);

  const resetGraph = useCallback(() => {
    setGraphPlaying(false);
    setGraphSecond(maxSeconds);
  }, [maxSeconds]);

  if (!results) {
    return (
      <div style={styles.empty}>
        <h2>No Results Available</h2>
        <p>Upload datasets and run analysis, or fetch existing results.</p>
        <button onClick={fetchResults} style={styles.fetchBtn}>Fetch Results</button>
      </div>
    );
  }

  const datasetTabs = [
    ...(trainData ? [{ id: DATASET_TRAIN, label: "Train" }] : []),
    ...(test1Data ? [{ id: DATASET_TEST1, label: "Test" }] : []),
    ...(test2Data ? [{ id: DATASET_TEST2, label: "Test2" }] : []),
  ];

  // const contentTabs = isTrain
  //   ? [
  //       { id: TAB_THRESHOLDS, label: "Thresholds" },
  //       { id: TAB_GRAPHS, label: "Graphs" },
  //       { id: TAB_INTERPOLATION, label: "Data After Interpolation" },
  //     ]
  //   : [
  //       { id: TAB_OVERVIEW, label: "Overview" },
  //       { id: TAB_GRAPHS, label: "Graphs" },
  //       { id: TAB_CONFUSION, label: "Confusion Matrix" },
  //       { id: TAB_INTERPOLATION, label: "Data After Interpolation" },
  //     ];

    const contentTabs = isTrain
    ? [
        { id: TAB_THRESHOLDS, label: "Thresholds" },
        { id: TAB_GRAPHS, label: "Graphs" },
      ]
    : [
        { id: TAB_OVERVIEW, label: "Overview" },
        { id: TAB_GRAPHS, label: "Graphs" },
      ];

  const interpRows = current?.data_after_interpolation ?? [];
  const hasKurtosis = interpRows.length > 0 && interpRows[0] && "Kurtosis" in interpRows[0];

  const patchedData = visibleData.map(d => ({...d,
    benignPackets: d.Label === "BENIGN" ? d.FlowPackets_s : null,
    attackPackets: d.Label === "DDoS" ? d.FlowPackets_s : null,
    benignBytes: d.Label === "BENIGN" ? d.FlowBytes_s : null,
    attackBytes: d.Label === "DDoS" ? d.FlowBytes_s : null,
    benignDuration: d.Label === "BENIGN" ? d.FlowDuration : null,
    attackDuration: d.Label === "DDoS" ? d.FlowDuration : null,
    lowPackets: d.Warning === "LOW" ? d.FlowPackets_s : null,
    medPackets: d.Warning === "MED" ? d.FlowPackets_s : null,
    highPackets: d.Warning === "HIGH" ? d.FlowPackets_s : null,
  }));

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Detection Results</h2>

      <div style={styles.datasetBar}>
        <span style={styles.datasetLabel}>Dataset:</span>
        {datasetTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setDataset(tab.id);
              setActiveTab(tab.id === DATASET_TRAIN ? TAB_THRESHOLDS : TAB_OVERVIEW);
              setGraphSecond((normalized?.[tab.id] ?? results?.[tab.id])?.max_seconds ?? 0);
              setCurrentGraphIndex(0);
            }}
            style={{ ...styles.datasetTab, ...(dataset === tab.id ? styles.datasetTabActive : {}) }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!isTrain && trainData && (
        <p style={styles.thresholdNote}>Thresholds are from the Train dataset. Select Train to view them.</p>
      )}

      <div style={styles.tabBar}>
        {contentTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ ...styles.tab, ...(activeTab === tab.id ? styles.tabActive : {}) }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Only show the "No data" message if there are truly no datasets at all */}
      {!current && activeTab !== TAB_THRESHOLDS && !trainData && !test1Data && !test2Data && (
        <p style={styles.sectionDesc}>No data for this dataset.</p>
      )}
      {!isTrain && activeTab === TAB_OVERVIEW && current && (
        <div style={styles.cardGrid}>
          <div style={styles.card}>
            <h3>First Alert Generated</h3>
            <p><strong>Low Alert:</strong> {current.first_low ?? 0} sec</p>
            <p><strong>Medium Alert:</strong> {current.first_med ?? 0} sec</p>
            <p><strong>High Alert:</strong> {current.first_high ?? 0} sec</p>
            {/* <p><strong>Adaptive θ:</strong> {Number(current.threshold_theta ?? 0).toFixed(6)}</p> */}
          </div>
          <div style={styles.card}>
            <h3>Warning Counts</h3>
            <p>BENIGN: {current.warnings?.BENIGN ?? 0}</p>
            <p>LOW: {current.warnings?.LOW ?? 0}</p>
            <p>MEDIUM: {current.warnings?.MED ?? 0}</p>
            <p>HIGH: {current.warnings?.HIGH ?? 0}</p>
          </div>
        </div>
      )}

      {activeTab === TAB_GRAPHS && current && (
        <div style={styles.graphSection}>
          <div style={styles.graphNav}>
            <span>Graph: {currentGraphIndex + 1} of {graphTitles.length}</span>
            <button
              disabled={currentGraphIndex <= 0}
              onClick={() => setCurrentGraphIndex((i) => Math.max(0, i - 1))}
              style={styles.smallBtn}
            >
              Previous
            </button>
            <button
              disabled={currentGraphIndex >= graphTitles.length - 1}
              onClick={() => setCurrentGraphIndex((i) => Math.min(graphTitles.length - 1, i + 1))}
              style={styles.smallBtn}
            >
              Next
            </button>
          </div>
          <h4 style={styles.graphTitle}>{graphTitles[currentGraphIndex]}</h4>
          <div style={styles.graphControls}>
            <span>Time: 0s → {graphSecond}s / {maxSeconds}s</span>
            <button onClick={playGraph} disabled={graphPlaying} style={styles.smallBtn}>
              {graphPlaying ? "Playing…" : "Play (0 → end)"}
            </button>
            <button onClick={resetGraph} style={styles.smallBtn}>Show full</button>
          </div>

          {isTrain && (currentGraphIndex === 0 || currentGraphIndex === 1) && (
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={visibleData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                  <YAxis />
                  <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey={currentGraphIndex === 0 ? "FlowPackets_s" : "FlowBytes_s"}
                    name={currentGraphIndex === 0 ? "FlowPackets/s" : "FlowBytes/s"}
                    stroke="#3af921"
                    strokeWidth={2}
                    dot={{ fill: "#3af921", r: 3 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {!isTrain && currentGraphIndex === 0 && (
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={patchedData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                  <YAxis />
                  <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                  <Legend />
                    <Line type="monotone" dataKey="FlowPackets_s" name="FlowPackets/s" stroke="#333" strokeWidth={1} dot={false} connectNulls />
                    <Scatter data={patchedData} dataKey="benignPackets" name="BENIGN" fill="#3af921" />
                    <Scatter data={patchedData} dataKey="attackPackets" name="ALERT" fill="#f90e0e" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {!isTrain && currentGraphIndex === 1 && (
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={visibleData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                  <YAxis />
                  <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                    <Legend />
                    <Line type="monotone" dataKey="FlowBytes_s" name="FlowBytes/s" stroke="#333" strokeWidth={1} dot={false} connectNulls />
                    <Scatter data={patchedData} dataKey="benignBytes" name="BENIGN" fill="#3af921" />
                    <Scatter data={patchedData} dataKey="attackBytes" name="ALERT" fill="#f90e0e" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {!isTrain && currentGraphIndex === 2 && (
            <div style={styles.chartWrap}>
              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={visibleData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                  <YAxis />
                  <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                    <Legend />
                    <Line type="monotone" dataKey="FlowDuration" name="FlowDuration" stroke="#333" strokeWidth={1} dot={false} connectNulls />
                    <Scatter data={patchedData} dataKey="benignDuration" name="BENIGN" fill="#3af921" />
                    <Scatter data={patchedData} dataKey="attackDuration" name="ALERT" fill="#f90e0e" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {!isTrain && currentGraphIndex >= 3 && currentGraphIndex <= 6 && (() => {
            const levelIndex = currentGraphIndex - 3;
            const levels = ["LOW", "MED", "HIGH"];
            const colors = { LOW: "#f9fd0b", MED: "#eaa40c", HIGH: "#b30909" };
            const firstLow = current.first_low;
            const firstMed = current.first_med;
            const firstHigh = current.first_high;
            const peakSec = current.peak_sec;
            if (currentGraphIndex === 6) {
              return (
                <div style={styles.chartWrap}>
                  <ResponsiveContainer width="100%" height={420}>
                    <ComposedChart data={patchedData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                      <YAxis />
                      <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                        <Legend />
                        <Line type="monotone" dataKey="FlowPackets_s" name="FlowPackets/s" stroke="#333" strokeWidth={1} dot={false} connectNulls />
                        <Scatter data={patchedData} dataKey="lowPackets" name="LOW ALERTS" fill="#f9fd0b" />
                        <Scatter data={patchedData} dataKey="medPackets" name="MEDIUM ALERTS" fill="#eaa40c" />
                        <Scatter data={patchedData} dataKey="highPackets" name="HIGH ALERTS" fill="#b30909" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              );
            }
            if (levelIndex < 0 || levelIndex > 2) return null;
            const level = levels[levelIndex];
            const color = colors[level];
            const first = level === "LOW" ? firstLow : level === "MED" ? firstMed : firstHigh;
            return (
              <div style={styles.chartWrap}>
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={visibleData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                    <YAxis />
                    <Tooltip formatter={(v) => typeof v === "number" ? v.toExponential(2) : v} />
                      <Legend />
                      <Line type="monotone" dataKey="FlowPackets_s" name="FlowPackets/s" stroke="#333" strokeWidth={1} dot={false} connectNulls />
                      {first != null && <ReferenceLine x={first} stroke={color} strokeDasharray="4 4" />}
                      {peakSec != null && <ReferenceLine x={peakSec} stroke="#000" strokeWidth={2} />}
                      {/* <Scatter data={visibleData.filter((d) => d.Warning === level)} dataKey="FlowPackets_s" name={`${level} Alerts`} fill={color} /> */}
                      <Scatter data={patchedData} dataKey={`${level.toLowerCase()}Packets`} name={`${level} Alerts`} fill={color} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* {!isTrain && currentGraphIndex >= 6 && currentGraphIndex <= 8 && (() => {
            const kurtLevel = ["LOW", "MED", "HIGH"][currentGraphIndex - 6];
            const kurtData = visibleData.map((d) => ({ ...d, kurt: d.Kurtosis })).filter((d) => d.kurt != null);
            return (
              <div style={styles.chartWrap}>
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={kurtData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="second" type="number" domain={[0, maxSeconds]} />
                    <YAxis name="Kurtosis" />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="kurt" name="Kurtosis" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
                    {current.peak_sec != null && <ReferenceLine x={current.peak_sec} stroke="#000" strokeWidth={2} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()} */}
        </div>
      )}

      {/* {!isTrain && activeTab === TAB_CONFUSION && (
        <div style={styles.confusionSection}>
          <button onClick={() => setConfusionVisible(!confusionVisible)} style={styles.primaryButton}>
            {confusionVisible ? "Hide Confusion Matrices" : "View Confusion Matrix"}
          </button>
          {confusionVisible && current?.confusion_matrices && (
            <div style={styles.confusionGrid}>
              {["LOW", "MED", "HIGH"].map((level) => {
                const cm = current.confusion_matrices[level];
                const metrics = current.confusion_metrics?.[level];
                if (!cm || !Array.isArray(cm)) return null;
                const flat = [].concat(...cm);
                const maxVal = Math.max(...flat, 1);
                const [[tn, fp], [fn, tp]] = cm.length === 2 && cm[0].length === 2 ? cm : [[0, 0], [0, 0]];
                return (
                  <div key={level} style={styles.confusionCard}>
                    <h4>Confusion Matrix: {level} as ATTACK</h4>
                    <table style={styles.confusionTable}>
                      <thead>
                        <tr>
                          <th style={styles.confusionTableTh}></th>
                          <th style={{ ...styles.confusionTableTh, background: bluesColor(0.3) }}>Predicted BENIGN</th>
                          <th style={{ ...styles.confusionTableTh, background: bluesColor(0.7) }}>Predicted ATTACK</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={styles.confusionTableTd}><strong>Actual BENIGN</strong></td>
                          <td style={{ ...styles.confusionTableTd, background: bluesColor(tn / maxVal), color: tn > maxVal / 2 ? "#fff" : "#000" }}>{tn}</td>
                          <td style={{ ...styles.confusionTableTd, background: bluesColor(fp / maxVal), color: fp > maxVal / 2 ? "#fff" : "#000" }}>{fp}</td>
                        </tr>
                        <tr>
                          <td style={styles.confusionTableTd}><strong>Actual ATTACK</strong></td>
                          <td style={{ ...styles.confusionTableTd, background: bluesColor(fn / maxVal), color: fn > maxVal / 2 ? "#fff" : "#000" }}>{fn}</td>
                          <td style={{ ...styles.confusionTableTd, background: bluesColor(tp / maxVal), color: tp > maxVal / 2 ? "#fff" : "#000" }}>{tp}</td>
                        </tr>
                      </tbody>
                    </table>
                    {metrics && (
                      <div style={styles.metricsList}>
                        <span>Accuracy: {(metrics.accuracy * 100).toFixed(1)}%</span>
                        <span>Precision (ATTACK): {(metrics.precision_attack * 100).toFixed(1)}%</span>
                        <span>Recall (ATTACK): {(metrics.recall_attack * 100).toFixed(1)}%</span>
                        <span>F1 (ATTACK): {(metrics.f1_attack * 100).toFixed(1)}%</span>
                        {metrics.balanced_accuracy != null && (
                          <span>Balanced Accuracy: {(metrics.balanced_accuracy * 100).toFixed(1)}%</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )} */}

      {/* {activeTab === TAB_INTERPOLATION && current && (
        <div style={styles.tableSection}>
          <p style={styles.sectionDesc}>
            {isTrain ? "Train aggregated per-second (BENIGN)." : "Aggregated test data after per-second interpolation and labeling."}
          </p>
          <div style={styles.tableWrap}>
            <table style={styles.dataTable}>
              <thead>
                <tr>
                  <th style={styles.dataTableTh}>Seconds</th>
                  {!isTrain && <th style={styles.dataTableTh}>r(t)</th>}
                  <th style={styles.dataTableTh}>FlowPackets/s</th>
                  <th style={styles.dataTableTh}>FlowBytes/s</th>
                  <th style={styles.dataTableTh}>Label</th>
                  {!isTrain && (
                    <>
                      <th style={styles.dataTableTh}>Residual_L1</th>
                      <th style={styles.dataTableTh}>Warning</th>
                      {hasKurtosis && <th style={styles.dataTableTh}>Kurtosis</th>}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {interpRows.slice(0, 500).map((row, i) => (
                  <tr key={i}>
                    <td style={styles.dataTableTd}>{row.Seconds}</td>
                    {!isTrain && <td style={styles.dataTableTd}>{row["r(t)"] != null ? Number(row["r(t)"]).toFixed(4) : ""}</td>}
                    <td style={styles.dataTableTd}>{row["FlowPackets/s"] != null ? Number(row["FlowPackets/s"]).toExponential(2) : ""}</td>
                    <td style={styles.dataTableTd}>{row["FlowBytes/s"] != null ? Number(row["FlowBytes/s"]).toExponential(2) : ""}</td>
                    <td style={styles.dataTableTd}>{row.Label}</td>
                    {!isTrain && (
                      <>
                        <td style={styles.dataTableTd}>{row.Residual_L1 != null ? Number(row.Residual_L1).toFixed(4) : ""}</td>
                        <td style={styles.dataTableTd}>{row.Warning}</td>
                        {hasKurtosis && <td style={styles.dataTableTd}>{row.Kurtosis != null ? Number(row.Kurtosis).toFixed(4) : ""}</td>}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {interpRows.length > 500 && (
            <p style={styles.tableNote}>Showing first 500 rows. Total: {interpRows.length} rows.</p>
          )}
        </div>
      )} */}

      {/* {isTrain && activeTab === TAB_THRESHOLDS && trainData && (
        <div style={styles.thresholdSection}>
          <div style={styles.card}>
            <h3>Manhattan (L1) thresholds</h3>
            <p>L1-LOW: {Number(trainData.thresholds?.["L1-LOW"] ?? 0).toFixed(4)}</p>
            <p>L1-MED: {Number(trainData.thresholds?.["L1-MED"] ?? 0).toFixed(4)}</p>
            <p>L1-HIGH: {Number(trainData.thresholds?.["L1-HIGH"] ?? 0).toFixed(4)}</p>
          </div>
          {trainData.per_feature_thresholds && (
            <div style={styles.card}>
              <h3>Per-feature residual (μ, σ)</h3>
              {Object.entries(trainData.per_feature_thresholds).map(([feat, v]) => (
                <p key={feat}>{feat}: μ = {Number(v.mu).toFixed(4)}, σ = {Number(v.std).toFixed(4)}</p>
              ))}
            </div>
          )}
          {trainData.residual_stats && (
            <div style={styles.card}>
              <h3>Residual stats (train)</h3>
              {Object.entries(trainData.residual_stats).map(([feat, v]) => (
                <p key={feat}>{feat}: mean={Number(v.mean).toFixed(4)}, std={Number(v.std).toFixed(4)}, max={Number(v.max).toFixed(4)}</p>
              ))}
            </div>
          )}
        </div>
      )} */}
    </div>
  );
}

const styles = {
  container: { padding: "24px 32px", maxWidth: "1200px", margin: "0 auto" },
  title: { marginBottom: "24px", color: "#1e293b" },
  empty: { textAlign: "center", marginTop: "100px" },
  fetchBtn: { marginTop: "16px", padding: "12px 24px", background: "#6366f1", color: "white", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: "600" },
  datasetBar: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px", flexWrap: "wrap" },
  datasetLabel: { fontWeight: "600", color: "#475569" },
  datasetTab: { padding: "10px 20px", border: "1px solid #cbd5e1", background: "#f8fafc", borderRadius: "8px", cursor: "pointer", fontWeight: "500" },
  datasetTabActive: { background: "#0f172a", color: "white", border: "1px solid #0f172a" },
  thresholdNote: { fontSize: "14px", color: "#64748b", marginBottom: "12px" },
  tabBar: { display: "flex", gap: "8px", marginBottom: "24px", flexWrap: "wrap" },
  tab: { padding: "10px 18px", border: "1px solid #cbd5e1", background: "#f8fafc", borderRadius: "8px", cursor: "pointer", fontWeight: "500" },
  tabActive: { background: "#6366f1", color: "white", border: "1px solid #6366f1" },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" },
  card: { background: "#f8fafc", padding: "24px", borderRadius: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.06)" },
  graphSection: { marginBottom: "24px" },
  graphNav: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px", flexWrap: "wrap" },
  graphTitle: { marginBottom: "12px", color: "#334155" },
  graphControls: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px", flexWrap: "wrap" },
  smallBtn: { padding: "8px 16px", background: "#64748b", color: "white", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px" },
  chartWrap: { background: "#fff", padding: "16px", borderRadius: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.06)", marginBottom: "8px" },
  confusionSection: { marginBottom: "24px" },
  primaryButton: { padding: "14px 28px", background: "#6366f1", color: "white", border: "none", borderRadius: "10px", cursor: "pointer", fontWeight: "600", marginBottom: "20px" },
  confusionGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px" },
  confusionCard: { background: "#f8fafc", padding: "20px", borderRadius: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.06)" },
  confusionTable: { width: "100%", borderCollapse: "collapse", marginTop: "12px", marginBottom: "12px" },
  confusionTableTh: { padding: "10px", border: "1px solid #cbd5e1", background: "#f1f5f9" },
  confusionTableTd: { padding: "12px 16px", border: "1px solid #cbd5e1" },
  metricsList: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "14px", color: "#475569" },
  tableSection: { marginBottom: "24px" },
  sectionDesc: { marginBottom: "12px", color: "#64748b" },
  tableWrap: { overflowX: "auto", background: "#fff", borderRadius: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.06)" },
  dataTable: { width: "100%", borderCollapse: "collapse", fontSize: "14px" },
  dataTableTh: { padding: "12px 16px", textAlign: "left", borderBottom: "2px solid #e2e8f0", background: "#f1f5f9" },
  dataTableTd: { padding: "10px 16px", borderBottom: "1px solid #e2e8f0" },
  tableNote: { marginTop: "8px", fontSize: "14px", color: "#64748b" },
  thresholdSection: { display: "flex", flexDirection: "column", gap: "20px" },
};

export default Results;

