import os

# Gunicorn configuration for Render deployment
# Automatically sets timeout to 3600s so 1GB uploads/downloads never hit worker timeout
bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"
workers = 1
threads = 4
timeout = 3600
keepalive = 65
graceful_timeout = 60
