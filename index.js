console.log('APP START');

const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(process.env.PORT || 3000, '0.0.0.0');