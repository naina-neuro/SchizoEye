
# Oculomotor Battery for Schizophrenia Risk Assessment

A complete web-based eye-tracking test battery that records smooth pursuit, fixation stability, antisaccade, and free-viewing tasks using a standard webcam. Extracted oculomotor features are sent to a Flask backend running an XGBoost classifier to predict the likelihood of healthy control (HC), first-episode schizophrenia (FES), or chronic schizophrenia (CSZ). The system also automatically logs data to a local database and generates downloadable, clinical-grade PDF reports.

-----

## 📋 Table of Contents

  - [Overview](https://www.google.com/search?q=%23overview)
  - [Features](https://www.google.com/search?q=%23features)
  - [Prerequisites](https://www.google.com/search?q=%23prerequisites)
  - [Installation](https://www.google.com/search?q=%23installation)
  - [Running the Application](https://www.google.com/search?q=%23running-the-application)
  - [Usage](https://www.google.com/search?q=%23usage)
  - [Data Collection & PDF Reports](https://www.google.com/search?q=%23data-collection--pdf-reports)
  - [Machine Learning Model](https://www.google.com/search?q=%23machine-learning-model)
  - [File Structure](https://www.google.com/search?q=%23file-structure)
  - [Dependencies](https://www.google.com/search?q=%23dependencies)
  - [Notes](https://www.google.com/search?q=%23notes)
  - [License](https://www.google.com/search?q=%23license)

-----

## 🧠 Overview

This project combines:

  - **Frontend** – an interactive HTML/JS interface that uses [WebGazer.js](https://webgazer.cs.brown.edu/) for real-time webcam eye tracking.
  - **Backend** – a Flask API that receives 59 oculomotor features, evaluates them via an XGBoost model, dynamically generates gaze heatmaps, and complies clinical PDF reports using WeasyPrint.
  - **Database** – a local SQLite database that automatically logs all session data, raw gaze points, and AI predictions.

The test battery includes:

1.  **SPEM (Smooth Pursuit Eye Movement)** – horizontal and Lissajous patterns to assess pursuit gain, saccadic intrusions, and signal-to-noise ratio.
2.  **SchizoEye** – fixation stability (with and without distractors) and antisaccade task (inhibitory control).
3.  **Free Viewing** – 25 natural images, 8 seconds each, to record natural gaze behavior.

-----

## ✨ Features

  - **No external hardware** – works with any webcam (requires good lighting).
  - **Full-screen calibration** – 13-point calibration with blink detection and head‑movement compensation.
  - **Three standard oculomotor tasks** with step‑by‑step audio/visual instructions.
  - **Automatic feature extraction** – pure JavaScript implementation of the 59 features required by the model.
  - **Flask API & ML Classification** – accepts feature vectors and returns class probabilities (HC/FES/CSZ).
  - **Automated Clinical Reports** – generates a multi-page, formatted PDF report containing Plotly charts, dark-theme visualizations, and patient metrics.
  - **Dynamic Heatmaps** – Python backend uses Matplotlib and SciPy to generate Gaussian-smoothed gaze heatmaps on the fly.
  - **Data Persistence** – auto-saves all results to `eye_tracking_data.db`.

-----

## 📦 Prerequisites

  - Python 3.8 or higher
  - Modern web browser (Chrome, Edge, or Firefox recommended)
  - Webcam and good ambient lighting
  - **For Windows Users (PDF Generation):** You MUST install the [GTK3 Runtime Environment](https://www.google.com/search?q=https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases) and add it to your system PATH for WeasyPrint to render PDFs correctly.

-----

## 🛠 Installation

1.  **Clone this repository** (or download the files).

2.  **Install Python dependencies**:

    ```bash
    pip install flask flask-cors joblib pandas scikit-learn xgboost weasyprint matplotlib scipy
    ```

3.  **Place the ML model files** in the root directory:

      - `schizo_multiclass_model.pkl`
      - `feature_scaler.pkl`
      - `label_encoder.pkl`
        *(Note: These files are not included in this repository and must be obtained separately).*

4.  **Set up the Stimuli:** Create a folder named `stimuli` in the root directory and add 25 images named `1.jpg` through `25.jpg`.

5.  **Set up the Templates:** Create a folder named `templates` in the root directory and place the `report_template.html` file inside it. Flask requires this exact folder structure to generate the PDF.

-----

## 🚀 Running the Application

Because the application saves to a local SQLite database, using auto-refreshing development servers (like VS Code Live Server) will cause the page to reload prematurely. **You must run two separate local servers:**

1.  **Start the Flask Backend (Terminal 1):**
    Open a terminal and run:

    ```bash
    python app.py
    ```

    *Wait until you see `✓ Models loaded successfully` and it is running on port 5000.*

2.  **Start the Frontend Server (Terminal 2):**
    Open a **second** terminal window and run Python's built-in static server:

    ```bash
    python -m http.server 8000
    ```

3.  **Access the Application:**
    Open your web browser and navigate to:
    `http://localhost:8000/frontend/index.html`
    `http://localhost:5000`

-----

## 📝 Usage

### Calibration

  - A 13‑point calibration screen appears first.
  - Look at each circle and click it repeatedly until it disappears (10 clicks per point).
  - Calibration accuracy is displayed as “ERR” in the top‑left HUD (a value below 60 px is good).

### Tasks

#### 1\. SPEM (Smooth Pursuit)

  - Follow a red dot with your eyes while keeping your head still. Includes a practice trial followed by three 20‑second sequences (Horizontal and Lissajous).

#### 2\. SchizoEye

  - **Fixation Stability** – Stare at the center dot while ignoring peripheral distractors.
  - **Antisaccade** – When a dot flashes to one side, immediately look to the **opposite** side.

#### 3\. Free Viewing

  - Look naturally at 25 sequentially presented images (8 seconds each).

-----

## 📊 Data Collection & PDF Reports

Once all tasks are completed, the frontend will automatically calculate the 59 metrics, send them to the backend for classification, and save the session to `eye_tracking_data.db`.

On the final results screen, you can:

  - **Download PDF Report:** Clicks the "↓ Download PDF Report" button to send screen captures (Plotly charts, Canvas scatters) to the backend. The backend will generate a heatmap, inject the metrics into the HTML template, and return a formatted PDF.
  - **Download CSVs:** Export raw gaze data, timestamps, and target coordinates for offline analysis.

-----

## 🤖 Machine Learning Model

The backend `/classify` endpoint expects a JSON object containing the 59 required features. It scales the features and passes them through an XGBoost multiclass model, returning a JSON response:

```json
{
  "success": true,
  "prediction": "HC",
  "probabilities": {
    "HC": 0.85,
    "FES": 0.10,
    "CSZ": 0.05
  }
}
```

The frontend computes these features natively via JavaScript, measuring scanpath lengths, RMSE, signal-to-noise ratios, saccadic velocities, and error rates.

-----

## 📁 File Structure

```text
.
├── app.py                          # Flask backend (API, DB, PDF/Heatmap generator)
├── schizoeye_complete.html         # Frontend interface (WebGazer, UI, Feature Extraction)
├── eye_tracking_data.db            # SQLite database (auto-generated)
├── schizo_multiclass_model.pkl     # XGBoost model (must be provided)
├── feature_scaler.pkl              # StandardScaler (must be provided)
├── label_encoder.pkl               # LabelEncoder (must be provided)
├── templates/
│   └── report_template.html        # HTML structure for WeasyPrint PDF generation
├── stimuli/                        
│   ├── 1.jpg                       # Free-viewing images
│   └── ...
└── README.md                       
```

-----

## 📦 Dependencies

**Backend (Python):**

  - `Flask`, `Flask-CORS`
  - `joblib`, `pandas`, `scikit-learn`, `xgboost`, `numpy`
  - `weasyprint` (Requires system-level GTK3 libraries)
  - `matplotlib`, `scipy` (For heatmap generation)

**Frontend (JavaScript):**

  - [WebGazer.js](https://webgazer.cs.brown.edu/) – included via `<script>`
  - [Plotly.js](https://plotly.com/javascript/) – included via CDN

-----

## 📌 Notes

  - **Lighting is critical** – ensure your face is well‑lit and the camera is stable.
  - **Head movement** – the algorithm compensates for small head translations, but try to keep your head still.
  - **Model files** – you must provide the `.pkl` files; they are not included in this repository due to data privacy restrictions.
  - **Missing Images** – the free‑viewing task will proceed even if some images are missing, but a warning will appear. At least 10 images are required to start.

-----

## 📄 License

This project is for research and educational purposes only. The code is provided “as is” without warranty. The machine learning model is not intended for clinical diagnosis.
