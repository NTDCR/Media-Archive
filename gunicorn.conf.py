import os

# Gunicorn configuration for Render deployment
# Render dynamically passes PORT (typically 10000)
port = os.environ.get("PORT", "10000")
bind = f"0.0.0.0:{port}"

# Optimized for Render Free Tier (512MB RAM, 0.5 CPU)
# 1 worker with 4 threads avoids memory bloat while supporting concurrent streaming
workers = 1
threads = 4
worker_class = "gthread"
timeout = 3600
keepalive = 65
graceful_timeout = 60
accesslog = "-"
errorlog = "-"
loglevel = "info"
