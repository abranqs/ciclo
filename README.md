# Ciclo — computador de bordo de ciclismo no celular

App web instalável (PWA) para Android que faz o papel de um Edge no guidão:

- **GPS do celular**: velocidade, distância, trajeto e altitude estimada
- **Frequência cardíaca por Bluetooth**: Amazfit T-Rex 3 Pro com a transmissão de FC ligada, ou cinta peitoral. Se o sensor cai, o app avisa uma vez, mostra "reconectando…" e tenta de novo sozinho (2, 5, 10, 20 s e depois a cada 30 s enquanto o pedal durar)
- **Cadência/velocidade por Bluetooth**: sensores no padrão CSC, como o XOSS
- **Zonas de FC por limiar** (LTHR 164, FCmax 186; tetos Z1–Z5 = 138, 151, 158, 165, 186) com a cor da zona no campo de FC
- **Alertas de FC** acima ou abaixo de um limite, com bipe e vibração
- **Páginas de campos à sua escolha**: segure um campo para trocá-lo, adicionar ou remover campos (até 12 espaços por página), mudar largura, altura e ordem, ou criar e apagar páginas (até 10)
- **Voltas e pausa automática**
- **Gravação à prova de queda**: salva a cada 10 s; se o navegador fechar, o pedal volta pausado
- **Histórico**: os 30 pedais mais recentes ficam no celular (Menu → Histórico), com resumo, TCX para baixar de novo e apagar
- **Trava de tela**: o cadeado ao lado de Pausar bloqueia toques de suor, chuva e luva; só Volta e Pausar respondem. Segure o cadeado 1,5 s para destravar. Com o pedal rodando, segurar um campo não abre o editor
- **Exporta TCX** para o Strava e o intervals.icu (FC, cadência, trajeto, voltas)
- **Funciona sem internet** depois de instalado

Endereço: https://abranqs.github.io/ciclo/ · teste sem sensores: https://abranqs.github.io/ciclo/?demo=1

## Rotas e treinos

- **Treinos**: os treinos de bike do seu plano, publicados pelo treino-ia, são executados passo a passo. A tela mostra tempo restante, alvo de FC com a faixa desenhada, contagem 3-2-1 e bipe quando você sai do alvo. Cada passo vira uma volta no TCX.
- **Rotas**: as rotas publicadas pelo treino-ia, ou GPX/TCX de qualquer app, ou KML/KMZ desenhados no **Google Earth**. Na tela da rota: mapa de **satélite**, ruas ou relevo, próxima curva com aviso aos 200 m, alerta de saída da rota, distância e subida restantes, hora estimada de chegada e perfil de altimetria.
- **Google Earth**: botão que abre a rota no app do Google Earth (em 3D) e link para o Google Maps até o início. Rotas do Earth sem altitude ganham altimetria pelo relevo Copernicus (Open-Meteo).
- **De onde vêm**: o treino-ia, no computador, publica treinos e rotas no repositório **privado** `abranqs/ciclo-dados` a cada sincronização. O app lê com um token (Contents: leitura; Issues: escrita, para mandar o pedal ao computador), configurado em Menu → Sincronização. Arquivos também entram pelo **Compartilhar** do Android.

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

## FC do Amazfit T-Rex 3 Pro

1. No relógio, ligue a **transmissão de frequência cardíaca** (Heart rate broadcast / Compartilhar FC).
2. No Ciclo: Sensores → Frequência cardíaca → **Conectar** → escolha o relógio na lista. Se ele não aparecer, desligue e ligue a transmissão de novo, com o relógio perto do celular.
3. O app solta o relógio sozinho ao encerrar o pedal, ou ao sair dele parado, para não atrapalhar a sincronização com o Zepp.
4. Se você abriu um treino no relógio só para transmitir a FC, **descarte** essa atividade no relógio, para não duplicar o pedal.

Uma cinta peitoral Bluetooth mede melhor no ciclismo: o sensor de pulso sofre com a vibração e com a pegada no guidão.

## Limites (honestos)

- **A tela precisa ficar ligada.** O Android suspende o navegador com a tela apagada. O app pede para manter a tela acesa; use suporte de guidão e, em pedal longo, uma bateria externa.
- **A altitude vem do GPS**, com margem de ±10–20 m. A subida mostrada é uma estimativa filtrada. O número confiável é o que o Strava calcula pelo mapa de relevo quando você importa o arquivo.
- **Os sensores precisam ser pareados de novo a cada abertura do app.** O navegador não guarda o pareamento; são dois toques.

## Levar o pedal para fora do celular

- **TCX**: Resumo (ou Menu → Histórico) → **Baixar TCX**. O Strava importa em strava.com/upload/select; o intervals.icu também aceita o arquivo.
- **Cadência para o computador**: ao encerrar, o app manda as séries de cadência, FC e velocidade para o treino-ia. Se não houver sinal, o pedal fica marcado **a enviar** no Histórico e vai sozinho quando a rede voltar ou na próxima vez que o app abrir; o botão **Enviar agora** força. Um pedal já aceito não é enviado de novo.
