# Ciclo — computador de bordo de ciclismo no celular

App web instalável (PWA) para Android que faz o papel de um Edge no guidão:

- **GPS do celular**: velocidade, distância, trajeto e altitude estimada
- **Frequência cardíaca por Bluetooth**: Garmin em modo de transmissão ou cinta peitoral
- **Cadência/velocidade por Bluetooth**: sensores no padrão CSC, como o XOSS
- **Zonas de Karvonen** (FCmax 185 / repouso 57, ajustáveis) com a cor da zona no campo de FC
- **Alertas de FC** acima ou abaixo de um limite, com bipe e vibração
- **Voltas, pausa automática, 5 páginas de campos**: segure um campo para trocá-lo
- **Gravação à prova de queda**: salva a cada 10 s; se o navegador fechar, o pedal volta pausado
- **Exporta TCX** para o Garmin Connect e o Strava (FC, cadência, trajeto, voltas)
- **Funciona sem internet** depois de instalado

Endereço: https://abranqs.github.io/ciclo/ · teste sem sensores: https://abranqs.github.io/ciclo/?demo=1

## Instalar

1. No Android, abra o endereço no **Chrome**.
2. Menu ⋮ → **Adicionar à tela inicial** (ou **Instalar app**).
3. Deixe Bluetooth e Localização ligados.

## FC do Forerunner 245

O FR245 só transmite FC por Bluetooth dentro da atividade **Corrida virtual**:

1. No relógio: iniciar atividade → **Corrida virtual**. Se ela não aparecer, adicione em Configurações → Atividades e apps → Adicionar.
2. Deixe o relógio nessa tela.
3. No Ciclo: Sensores → Frequência cardíaca → **Conectar** → escolha o Forerunner.
4. Ao fim do pedal, **descarte** a corrida virtual no relógio, para não duplicar a atividade.

Uma cinta peitoral Bluetooth dispensa isso e mede melhor no ciclismo: o sensor de pulso sofre com a vibração e com a pegada no guidão.

## Limites (honestos)

- **A tela precisa ficar ligada.** O Android suspende o navegador com a tela apagada. O app pede para manter a tela acesa; use suporte de guidão e, em pedal longo, uma bateria externa.
- **A altitude vem do GPS**, com margem de ±10–20 m. A subida mostrada é uma estimativa filtrada. O número confiável é o que o Garmin Connect ou o Strava calculam pelo mapa de relevo quando você importa o arquivo.
- **Os sensores precisam ser pareados de novo a cada abertura do app.** O navegador não guarda o pareamento; são dois toques.

## Mandar o pedal para o Garmin Connect

Resumo → **Baixar TCX**. Depois, em connect.garmin.com → ícone de nuvem (Importar dados) → escolha o arquivo.
