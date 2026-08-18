import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '회의실 예약 API',
      version: '1.0.0',
      description: 'ERP 회의실 예약 관리 백엔드 API 문서',
    },
    servers: [
      { url: 'http://localhost:8080', description: '로컬 개발 서버' },
    ],
  },
  apis: ['./src/modules/**/*.router.ts', './src/modules/**/*.controller.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
