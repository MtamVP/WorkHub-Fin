const fs = require('fs');

async function testUpload() {
  try {
    console.log('Sending request to Edge Function...');
    const form = new FormData();
    form.append('bucket', 'wh-fin-files');
    form.append('path', 'test_upload.txt');
    form.append('file', new Blob(['test']), 'test_upload.txt');

    const res = await fetch('https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/storage-proxy/upload', {
      method: 'POST',
      body: form
    });
    
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response:', text);
  } catch (e) {
    console.error('Error:', e);
  }
}

testUpload();
