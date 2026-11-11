# Numerical validation and verification

This folder contains the Python scripts used during the manuscript audit and Fourth-draft verification. They are read-only audit utilities; they do not contain application code, datasets, model weights, or generated outputs.

## Included scripts

- `verify_fourth.py` — checks the Fourth draft against the recorded source inspection and implemented-change manifest, including document structure, tables, package integrity, and protected source details.
- `build_audit_tables.py` — builds the claim, numerical-value, and page-location audit tables from the saved manuscript blocks and verification results.
- `independent_check.py` — performs independent numerical and file-integrity checks and writes its audit inventory in the audit-work directory.
- `final_check.py` — checks the saved boundary probes, claim checks, and completion conditions used for the final audit.
- `check_package.py` — safely extracts and checks the reproducibility archive, its manifest, and its included files.
- `check_links.py` — checks the configured DOI, URL, and repository endpoints; network access is required.
- `recompute_extension.py` — recomputes grouped summary statistics for the expanded deterministic verification trajectories.

## Dependencies and execution

The scripts use Python's standard library plus the packages used by the manuscript workflow, including `python-docx`, `lxml`, `Pillow`, `pypdf`, and `pdf2image` where applicable. They expect the original repository layout and the saved audit/manuscript artifacts in their original locations (for example `submission_audit_2026-11-06`, `revision_work`, `fourth_draft_work`, and the manuscript DOCX files). Run them from the repository root or adapt their path assumptions. `check_links.py` additionally requires network access. The scripts should be run against a copy or in a controlled audit workspace because some write audit reports beside their source data.
