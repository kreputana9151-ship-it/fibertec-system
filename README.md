Fibertec ISP Management System

---

Repository Structure
* `fibertec/` - Frontend UI (HTML, CSS, JS)
* `fibertec-api/` - Backend REST API & PostgreSQL Schema

---

Requirements
Siguraduhing naka-install na mga to sa PC niyo:
* Node.js (v18+)
* PostgreSQL
* Git

---

Step 1: Clone the Repository
Buksan niyo yung Terminal / Command Prompt at i-run to:

git clone [https://github.com/kreputana9151-ship-it/fibertec-system.git](https://github.com/kreputana9151-ship-it/fibertec-system.git)
cd fibertec-system

---

Step 2: Database Setup (PostgreSQL)

Open niyo yung pgAdmin or psql tas gumawa ng database:
CREATE DATABASE fibertec;
I-run niyo yung SQL schema file sa loob ng backend folder:
fibertec-system/fibertec-api/fibertec_schema_postgres.sql

---

Step 3: Backend Setup (fibertec-api)
Pumunta sa backend folder:
Bash
cd fibertec-api

Gumawa ng .env file based sa .env.example:
DATABASE_URL=postgres://postgres:ANG_PASSWORD_MO@localhost:5432/fibertec
JWT_SECRET=super-secret-fibertec-key-2026

I-install yung dependencies then i-run yung seed data & server:
npm install
npm run seed
npm run dev

---

Daily Git Commands
git pull
git add .
git commit -m "Describe your changes"
git push

---
