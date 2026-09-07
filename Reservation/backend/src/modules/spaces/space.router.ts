import { Router } from 'express';
import { spaceController } from './space.controller';

export const spaceRouter = Router();

spaceRouter.get('/', spaceController.getSpaces);
spaceRouter.get('/:id', spaceController.getSpaceById);
spaceRouter.post('/test-spaces', spaceController.createTestSpaces);
spaceRouter.post('/', spaceController.createSpace);
spaceRouter.patch('/:id', spaceController.updateSpace);
spaceRouter.delete('/:id', spaceController.deleteSpace);
