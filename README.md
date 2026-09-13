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

## Rotas e treinos do Garmin

- **Treinos**: os treinos de bike do seu calendário do Garmin Connect, incluindo os do ciclo enviados pelo treino-ia, são executados passo a passo. A tela mostra tempo restante, alvo de FC com a faixa desenhada, contagem 3-2-1 e bipe quando você sai do alvo. Cada passo vira uma volta no TCX.
- **Rotas**: seus cursos de bike do Garmin Connect, ou GPX/TCX de qualquer lugar, ou KML/KMZ desenhados no **Google Earth**. Na tela da rota: mapa de **satélite**, ruas ou relevo, próxima curva com aviso aos 200 m, alerta de saída da rota, distância e subida restantes, hora estimada de chegada e perfil de altimetria.
- **Google Earth**: botão que abre a rota no app do Google Earth (em 3D) e link para o Google Maps até o início. Rotas do Earth sem altitude ganham altimetria pelo relevo Copernicus (Open-Meteo).
- **De onde vêm**: o treino-ia, no computador, publica treinos e rotas no repositório **privado** `abranqs/ciclo-dados` a cada sincronização. O app lê com um token só de leitura, configurado em Menu → Sincronização. Arquivos também entram pelo **Compartilhar** do Android.

O que funciona sem internet: treino, linha da rota, curvas, desvio e altimetria. O fundo do mapa precisa de sinal; o que você já viu fica guardado.

## Estrada à frente (sem rota)

Campo embaixo do mapa, na 4ª página. Ocupa duas linhas de altura. Mostra o perfil dos próximos 2,5 km da estrada em que você está, colorido pela inclinação, com a frase do trecho atual e do próximo: "Subindo +4.8% por 250 m · subida em 700 m: 1.1 km a +6.0%". Quando você se aproxima de uma subida de 300 m ou mais, soa um bipe com o aviso, ~400 m antes. O aviso pode ser desligado em Ajustes.

- **Estradas**: OpenStreetMap, em blocos do OpenFreeMap. O app casa o GPS e o seu sentido com a via e segue por ela. Em cada cruzamento, continua na mesma via; se ela acaba, pega a saída mais reta, sem trocar rua por trilha. Num T, ou numa bifurcação sem saída óbvia, a previsão para no cruzamento.
- **Modo subida** (como o ClimbPro do Edge): a partir de ~800 m antes de uma subida de 300 m ou mais, o campo passa a mostrar só a subida. O perfil vem colorido por inclinação (verde até 3%, amarelo até 6%, laranja até 9%, vermelho até 12%, vinho acima), com o alfinete da inclinação de agora e a barra de progresso. Embaixo: inclinação, distância até o topo e metros que faltam subir.
- **No mapa**: a estrada assumida aparece tracejada em amarelo. Se não for por onde você vai, ignore o perfil até entrar na outra via; ele se refaz em 3 s.
- **Relevo**: SRTM de 30 m (blocos Terrarium da AWS). Pontes e túneis são interpolados.
- **Com rota ativa** e você sobre ela, o perfil vem da rota.
- **Teste em 4 rotas reais** (Mandacaru, Águas–Patrimônio, Vinhedo, Inconfidentes), com a rota desligada: a previsão seguiu a estrada certa por 1,5 a 2,5 km na mediana. O erro de altitude relativa ficou entre 2 e 4 m na mediana, e entre 6 e 13 m em 90% dos pontos.
- Estradas e relevo já vistos ficam guardados no celular. Área nova precisa de internet (~100–300 kB por bloco de 2,3 km).

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
