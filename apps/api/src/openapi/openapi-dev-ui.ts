import { dirname, join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express, Request, Response } from 'express';

import { OPENAPI_DOCUMENT_ROUTE, OPENAPI_UI_ROUTE } from './openapi-document';

/** The Swagger UI files served in development, and nothing else from the package. */
const ASSETS: Readonly<Record<string, string>> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'application/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'application/javascript; charset=utf-8',
  'favicon-32x32.png': 'image/png',
};

/** `swagger-ui-dist`, as installed for `@nestjs/swagger` — no dependency of its own. */
function swaggerUiDist(): string {
  const swagger = dirname(require.resolve('@nestjs/swagger/package.json'));
  return dirname(require.resolve('swagger-ui-dist/package.json', { paths: [swagger] }));
}

/**
 * Mounts the Swagger UI — **development only** (`APP_ENV=development` and
 * `OPENAPI_UI_ENABLED=true`, Phase 1C.3 ADR G1/G4). Never called in any other
 * environment, where `/api/v1/docs` is an unknown route.
 *
 * The page and its initializer are written here rather than taken from
 * `SwaggerModule.setup`, because that initializer embeds the whole document.
 * This one only names the document route; the UI fetches the document from
 * `GET /api/v1/openapi.json`, the one route that produces it.
 */
export function mountDevelopmentSwaggerUi(app: NestExpressApplication, globalPrefix: string): void {
  const base = `/${globalPrefix}/${OPENAPI_UI_ROUTE}`;
  const documentUrl = `/${globalPrefix}/${OPENAPI_DOCUMENT_ROUTE}`;
  const dist = swaggerUiDist();
  const http = app.getHttpAdapter().getInstance() as Express;

  const page = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>ACC API — development</title>',
    `<link rel="stylesheet" href="${base}/swagger-ui.css">`,
    `<link rel="icon" type="image/png" href="${base}/favicon-32x32.png">`,
    '</head>',
    '<body>',
    '<div id="swagger-ui"></div>',
    `<script src="${base}/swagger-ui-bundle.js"></script>`,
    `<script src="${base}/swagger-ui-standalone-preset.js"></script>`,
    `<script src="${base}/swagger-initializer.js"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const initializer = [
    'window.onload = function () {',
    '  window.ui = SwaggerUIBundle({',
    `    url: ${JSON.stringify(documentUrl)},`,
    "    dom_id: '#swagger-ui',",
    '    deepLinking: true,',
    '    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],',
    "    layout: 'StandaloneLayout',",
    '  });',
    '};',
    '',
  ].join('\n');

  http.get(base, (_request: Request, response: Response) => {
    response.type('html').send(page);
  });
  http.get(`${base}/swagger-initializer.js`, (_request: Request, response: Response) => {
    response.type('application/javascript').send(initializer);
  });
  for (const [file, contentType] of Object.entries(ASSETS)) {
    http.get(`${base}/${file}`, (_request: Request, response: Response) => {
      response.setHeader('Content-Type', contentType);
      response.sendFile(join(dist, file));
    });
  }
}
