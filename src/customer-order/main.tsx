import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CustomerOrderApp } from "./customer-order-app";
import "./styles.css";

createRoot(document.getElementById("customer-order-root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CustomerOrderApp />
    </BrowserRouter>
  </React.StrictMode>
);
