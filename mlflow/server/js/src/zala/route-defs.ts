import { createMLflowRoutePath, createRouteElement, type DocumentTitleHandle } from '../common/utils/RoutingUtils';
import ZalaPage from './ZalaPage';
import JobsPage from './JobsPage';

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
  {
    path: createMLflowRoutePath('/zala/jobs'),
    element: createRouteElement(JobsPage),
    pageId: 'zala.jobs',
    handle: { getPageTitle: () => 'ZALABench · Планировщик' } satisfies DocumentTitleHandle,
  },
];
