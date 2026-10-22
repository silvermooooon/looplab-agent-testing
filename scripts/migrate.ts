import { migrate, pool } from "../src/server/db.js";
await migrate();
await pool.end();
console.log("Database migrations applied.");
