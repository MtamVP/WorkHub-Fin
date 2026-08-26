FROM python:3.10

WORKDIR /app

# Cài đặt thư viện hệ thống cần thiết cho pdfplumber và các thư viện khác (nếu có)
RUN apt-get update && apt-get install -y \
    build-essential \
    libpoppler-cpp-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Mở cổng 8080 cho Cloud Run
EXPOSE 8080

# Chạy server FastAPI bằng Uvicorn, bind vào cổng 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
