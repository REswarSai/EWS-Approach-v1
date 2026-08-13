import torch.nn as nn

class DatasetGeneratorNN(nn.Module):
    def __init__(self, output_dim):
        super().__init__()
        layers = [nn.Linear(1, 30), nn.Tanh()]
        for _ in range(4):
            layers += [nn.Linear(30, 30), nn.Tanh()]
        layers += [nn.Linear(30, output_dim), nn.Sigmoid()]
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        return self.net(x)
