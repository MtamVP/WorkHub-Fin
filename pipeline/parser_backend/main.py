import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import traceback
# Tạm thời TẮT file_parser để test xem lỗi có phải do thư viện pdfplumber/pandas không
# from file_parser import extract_text, chunk_text

app = FastAPI(title="WorkHub Finance Parser Backend")

# Cho phép gọi từ Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "service": "Parser Backend is running"}

@app.post("/parse")
async def parse_file(file: UploadFile = File(...)):
    return {"success": True, "text": "Test bypass logic successful."}
