const path = require('node:path');
// The isolated wrapper runs from the ERP root; Reservation has its own compiler contract.
require('../Reservation/backend/node_modules/ts-node').register({
  project: path.resolve(__dirname, '../Reservation/backend/tsconfig.json'),
});
