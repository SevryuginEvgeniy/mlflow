/**
 * ZALABench — spike-страница.
 *
 * Доказывает, что аддитивная страница в UI MLflow собирается и открывается.
 * Данные будут приходить из нашего сервиса (FastAPI), не из API MLflow.
 */
import { Typography, useDesignSystemTheme } from '@databricks/design-system';

export const ZalaPage = () => {
  const { theme } = useDesignSystemTheme();

  return (
    <div css={{ padding: theme.spacing.lg }}>
      <Typography.Title level={2}>ZALABench</Typography.Title>
      <Typography.Paragraph>
        Spike-страница UI-форка. Здесь появятся метрики по датасетам и планировщик прогонов.
      </Typography.Paragraph>
    </div>
  );
};

export default ZalaPage;
