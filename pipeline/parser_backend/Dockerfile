FROM python:3.10-slim

WORKDIR /app

# Cài đặt thư viện hệ thống cần thiết cho pdfplumber
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpoppler-cpp-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Cài đặt các dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Ngăn Python giữ log trong bộ đệm (rất quan trọng để xem được lỗi)
ENV PYTHONUNBUFFERED=True

# Mở port (Cloud Run sẽ ghi đè biến này, mặc định là 8080)
ENV PORT=8080
EXPOSE $PORT

# Lệnh khởi chạy server (sử dụng shell form để nhận diện biến môi trường $PORT)
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
