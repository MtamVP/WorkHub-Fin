const fs = require('fs');

async function listModels() {
  const key = "AIzaSyCxtj-tIcHY1CvIc7P56ZTPSS95W0ssLlU";
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(JSON.stringify(data.models.map(m => m.name), null, 2));
  } catch (e) {
    console.error(e);
  }
}

listModels();
