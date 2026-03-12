const express = require('express');
const path = require('path');

const app = express();
const PORT = 5081;

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'readme.html'));
});

app.listen(PORT, () => {
  console.log(`Webapp server running at http://localhost:${PORT}`);
});
