FROM python:3.11-slim

# Install system libraries used by PDF generation and Python packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz0b \
    libpango1.0-dev \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libffi-dev \
    shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container.
WORKDIR /app

# Install dependencies first to improve Docker build-cache reuse.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend source code and supporting files.
COPY . .

# Use port 5000 locally unless the deployment supplies another port.
ENV PORT=5000
EXPOSE 5000

# Start Flask through Gunicorn with memory-conscious worker settings.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 4 --timeout 120 --max-requests 200 --max-requests-jitter 50 app:app"]