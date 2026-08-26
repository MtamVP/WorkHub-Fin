import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import traceback
from parser import extract_text, chunk_text

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
    if not file:
        raise HTTPException(status_code=400, detail="Không tìm thấy file")
        
    try:
        # Đọc nội dung byte của file
        file_bytes = await file.read()
        
        # Bóc tách văn bản thô (có bao gồm làm phẳng bảng biểu)
        raw_text = extract_text(file_bytes, file.filename)
        
        if not raw_text.strip():
            return {"success": False, "error": "File rỗng hoặc không thể trích xuất chữ."}
            
        # Chia chunk (dành cho RAG)
        chunks = chunk_text(raw_text)
        
        return {
            "success": True, 
            "fileName": file.filename,
            "text": raw_text,
            "chunks": chunks,
            "total_chunks": len(chunks)
        }
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}
