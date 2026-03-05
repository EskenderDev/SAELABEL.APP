# SAE.STUDIO

**Infraestructura Profesional para el Diseño y Gestión de Etiquetado Térmico**

SAE.STUDIO es un ecosistema integrado para la creación, gestión e impresión de etiquetas industriales. Combina la potencia de un motor de renderizado y comunicación en **C# .NET** con una interfaz de diseño moderna construida en **Tauri**, **React** y **Astro**.

---

## 🏛️ Arquitectura del Sistema

El sistema utiliza un modelo de **Sidecar Service**:
1. **SAE.STUDIO App (Frontend):** Interfaz de escritorio de alta performance que incluye el **Diseñador Visual de Etiquetas**.
2. **SAE.STUDIO.Api (Backend):** Un servicio de Windows que se ejecuta en segundo plano, exponiendo una API REST local en el puerto `5117` para procesar renders y gestionar la comunicación directa con hardware de impresión (ZPL/EPL).

## 🚀 Requisitos de Desarrollo
- **Entorno Web:** Node.js 20+
- **Escritorio:** Rust toolchain (Requerido para compilar Tauri)
- **Backend:** .NET 10.0 SDK
- **Hardware:** Impresoras térmicas (Zebra, Honeywell, Brother, etc.)

## 🛠️ Comandos de Inicio rápido

### Instalación de dependencias
```bash
npm install
```

### Desarrollo del Diseñador (Escritorio)
```bash
npm run tauri:dev
```

### Generación de Cliente API (OpenAPI)
Si realizas cambios en el backend, regenera el cliente tipado:
```bash
npm run gen:api
```
*Se intentará descargar el spec desde `http://localhost:5117/openapi/v1.json`.*

## 📄 Guías y Documentación
- **Guía de Despliegue:** [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) - Pasos detallados para configurar actualizaciones y el servicio de Windows.
- **Atajos del Editor:** [docs/EDITOR_COMMANDS.md](docs/EDITOR_COMMANDS.md) - Optimiza tu flujo de trabajo en el canvas.

## ⚖️ Licencia
Este proyecto está distribuido bajo la **MIT License**. Consulta el archivo [LICENSE](LICENSE) para más detalles.

---
© 2026 **EskenderDev**
