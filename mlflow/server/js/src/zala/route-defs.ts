import { createMLflowRoutePath, createRouteElement, type DocumentTitleHandle } from '../common/utils/RoutingUtils';
import ZalaPage from './ZalaPage';

/**
 * ZALABench routes (аддитивные, UI-форк).
 */
export const getZalaRouteDefs = () => [
  {
    path: createMLflowRoutePath('/zala'),
    element: createRouteElement(ZalaPage),
    pageId: 'zala.home',
    handle: { getPageTitle: () => 'ZALABench' } satisfies DocumentTitleHandle,
  },
];
