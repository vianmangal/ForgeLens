from flask import Flask

app = Flask(__name__)
app.config.update(
    DEMO_REGION="west",
    APP_SECRET="fake-secret",
    DATABASE_PASSWORD="fake-password",
    SERVICE_TOKEN="demo-only",
    API_KEY="fake-key",
)
